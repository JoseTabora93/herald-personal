"""Evidence snapshots for daily planning, distinct from executing a coding task."""

import json
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any, Literal, Self
from zoneinfo import ZoneInfo

from pydantic import Field, field_validator, model_validator

from .database import Database
from .errors import ServiceError
from .models import TIMEZONE, InputModel, utc_now, utc_timestamp
from .records import Records, digest

ObservationStatus = Literal[
    "active", "idle", "waiting_permission", "waiting_input", "retrying", "error", "ended", "unknown"
]
Identifier = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")]
Short = Annotated[str, Field(min_length=1, max_length=250)]
ModelError = Literal["not_configured", "timeout", "invalid_response", "provider_error"]


def timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def plan_day(value: str) -> str:
    parsed = date.fromisoformat(value)
    if value != parsed.isoformat():
        raise ValueError("La fecha debe ser YYYY-MM-DD.")
    return value


def today() -> str:
    return datetime.now(ZoneInfo(TIMEZONE)).date().isoformat()


class Observation(InputModel):
    observer_id: Identifier
    revision: Annotated[int, Field(strict=True, ge=1)]
    observed_at: str
    agent: Literal["claude", "opencode"]
    native_session_id: Identifier
    workspace: Annotated[str, Field(min_length=1, max_length=200)]
    status: ObservationStatus
    evidence_source: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,79}$")]
    confidence: Literal["high", "medium", "low"]
    source_updated_at: str | None = None
    stale_after_seconds: Annotated[int, Field(strict=True, ge=30, le=86400)] = 300
    signals: list[Short] = Field(default_factory=list, max_length=8)
    verification: Literal["not_run"] = "not_run"

    _observed = field_validator("observed_at")(utc_timestamp)

    @field_validator("source_updated_at")
    @classmethod
    def source_time(cls, value: str | None) -> str | None:
        return utc_timestamp(value) if value else None

    @model_validator(mode="after")
    def evidence_matches(self) -> Self:
        if (
            self.evidence_source in {"process_inventory", "session_mtime", "unavailable"}
            and self.status != "unknown"
        ):
            raise ValueError("La presencia de un proceso no prueba actividad de una sesión.")
        return self


class GeneratePlan(InputModel):
    date: str | None = None

    @field_validator("date")
    @classmethod
    def valid_day(cls, value: str | None) -> str | None:
        return plan_day(value) if value is not None else None


class RecommendationInput(InputModel):
    title: Short
    reason: Annotated[str, Field(min_length=1, max_length=1200)]
    evidence_refs: list[Identifier] = Field(min_length=1, max_length=8)


class PlanRecommendations(InputModel):
    expected_revision: Annotated[int, Field(strict=True, ge=1)]
    summary: Annotated[str, Field(min_length=1, max_length=4000)]
    model: Annotated[str, Field(min_length=1, max_length=120)]
    recommendations: list[RecommendationInput] = Field(min_length=1, max_length=8)


class PlanClaim(InputModel):
    owner: Identifier
    attempt_id: Identifier


class PlanError(InputModel):
    error: ModelError


class Planning:
    def __init__(
        self,
        database: Database,
        records: Records,
        mail_status: Callable[[], dict[str, Any]],
    ):
        self.db = database
        self.records = records
        self.mail_status = mail_status

    def observations(self) -> list[dict[str, Any]]:
        with self.db.connection() as connection:
            rows = connection.execute(
                "SELECT payload FROM agent_observations "
                "ORDER BY observed_at DESC,observer_id LIMIT 500"
            ).fetchall()
        now = datetime.now(UTC)
        output: list[dict[str, Any]] = []
        for row in rows:
            item = Observation.model_validate_json(row["payload"])
            stale = (now - timestamp(item.observed_at)).total_seconds() > item.stale_after_seconds
            output.append(
                {
                    **item.model_dump(),
                    "is_stale": stale,
                    "effective_status": "unknown" if stale else item.status,
                }
            )
        return output

    def observe(self, observer_id: str, item: Observation) -> Observation:
        if observer_id != item.observer_id:
            raise ServiceError(422, "La ruta no coincide con el observador.")
        if timestamp(item.observed_at) > datetime.now(UTC) + timedelta(minutes=5):
            raise ServiceError(422, "La observación no puede afirmar una lectura futura.")
        if item.source_updated_at and timestamp(item.source_updated_at) > timestamp(
            item.observed_at
        ) + timedelta(minutes=5):
            raise ServiceError(422, "La fecha de la fuente no es coherente con la observación.")
        hashed = digest(item.model_dump())
        with self.db.transaction() as connection:
            previous = connection.execute(
                "SELECT * FROM agent_observations WHERE observer_id=?", (observer_id,)
            ).fetchone()
            if previous:
                old = Observation.model_validate_json(previous["payload"])
                if item.revision < old.revision:
                    raise ServiceError(409, "El observador ya tiene una revisión posterior.")
                if item.revision == old.revision:
                    if hashed != previous["payload_hash"]:
                        raise ServiceError(409, "La revisión ya existe con otro contenido.")
                    return old
                if any(
                    getattr(item, key) != getattr(old, key)
                    for key in ("agent", "native_session_id", "workspace")
                ):
                    raise ServiceError(409, "La identidad de la sesión no puede cambiar.")
                if timestamp(item.observed_at) < timestamp(old.observed_at):
                    raise ServiceError(409, "La observación no puede retroceder.")
            connection.execute(
                "INSERT INTO agent_observations VALUES (?,?,?,?,?) ON CONFLICT(observer_id) "
                "DO UPDATE SET revision=excluded.revision,payload_hash=excluded.payload_hash,"
                "payload=excluded.payload,observed_at=excluded.observed_at",
                (observer_id, item.revision, hashed, item.model_dump_json(), item.observed_at),
            )
        return item

    def plans(self, selected: str | None = None) -> list[dict[str, Any]]:
        with self.db.connection() as connection:
            if selected:
                rows = connection.execute(
                    "SELECT payload FROM daily_plans WHERE date=?", (selected,)
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT payload FROM daily_plans ORDER BY date DESC LIMIT 31"
                ).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def generate(self, selected: str | None) -> dict[str, Any]:
        selected = selected or today()
        existing = self.plans(selected)
        if existing:
            return existing[0]
        if selected != today():
            raise ServiceError(422, "Solo se genera el plan del día local actual.")
        tasks = [item for item in self.records.tasks() if item.status not in {"done", "cancelled"}]
        observations = self.observations()
        now = utc_now()
        sources: list[dict[str, Any]] = []
        priorities: list[dict[str, str]] = []
        recommendations: list[dict[str, Any]] = []
        limitations = [
            "El calendario todavía no forma parte de este plan.",
            "Observar actividad de un agente no verifica sus cambios ni sus pruebas.",
        ]
        for task in tasks[:50]:
            ref = f"task:{task.id}"
            sources.append(
                {
                    "id": ref,
                    "kind": "task",
                    "status": "available",
                    "as_of": task.updated_at,
                    "description": task.title,
                }
            )
            if len(priorities) < 3 and task.status != "waiting":
                reason = "Compromiso pendiente."
                if task.due_at and timestamp(task.due_at) < timestamp(now):
                    reason = "La fecha comprometida ya venció."
                elif task.priority == "high":
                    reason = "Marcado con prioridad alta."
                priorities.append(
                    {
                        "id": ref,
                        "title": task.title,
                        "reason": reason,
                        "source_ref": ref,
                        "kind": "task",
                    }
                )
            if task.status == "waiting" and len(recommendations) < 4:
                recommendations.append(
                    {
                        "title": f"Retomar: {task.title}"[:250],
                        "reason": (
                            "El compromiso está en espera; confirma qué lo bloquea "
                            "y el siguiente paso."
                        ),
                        "evidence_refs": [ref],
                        "author": "rules",
                    }
                )
        try:
            mail = self.mail_status()
        except (ServiceError, OSError, ValueError):
            mail = {"reachable": False, "counts": None}
        counts = mail.get("counts") if mail.get("reachable") else None
        if not isinstance(counts, dict):
            counts = None
        sync = counts.get("ultimaSincronizacion") if counts else None
        sync_time = sync.get("fin") if isinstance(sync, dict) else None
        mail_state = "available" if counts is not None else "unavailable"
        if counts is not None:
            try:
                if (
                    not isinstance(sync_time, str)
                    or (datetime.now(UTC) - timestamp(sync_time)).total_seconds() > 86400
                    or timestamp(sync_time) > datetime.now(UTC) + timedelta(minutes=5)
                    or not isinstance(sync, dict)
                    or sync.get("estado") != "ok"
                ):
                    mail_state = "stale"
            except (TypeError, ValueError):
                mail_state = "stale"
        sources.append(
            {
                "id": "mail-workspace",
                "kind": "mail_workspace",
                "status": mail_state,
                "as_of": sync_time,
                "description": "Conteos del espacio de correo original.",
            }
        )
        mail_summary: dict[str, Any] = {
            "available": counts is not None,
            "last_sync_at": sync_time,
            "window_days": counts.get("ventanaDias") if counts else None,
            "total": 0,
            "needs_reply": 0,
            "waiting_reply": 0,
            "unclassified": 0,
        }
        if counts:
            states = counts.get("porEstado", {})
            for dest, value in (
                ("total", counts.get("total")),
                ("needs_reply", states.get("debo_respuesta") if isinstance(states, dict) else None),
                (
                    "waiting_reply",
                    states.get("esperando_respuesta") if isinstance(states, dict) else None,
                ),
                ("unclassified", counts.get("pendientesDeClasificar")),
            ):
                mail_summary[dest] = (
                    value if type(value) is int and 0 <= value <= 100_000_000 else 0
                )
            if mail_summary["needs_reply"]:
                recommendations.append(
                    {
                        "title": "Revisar los correos que requieren respuesta",
                        "reason": (
                            f"La clasificación guardada tiene {mail_summary['needs_reply']} "
                            "hilos en Debo respuesta; revisa su vigencia."
                        ),
                        "evidence_refs": ["mail-workspace"],
                        "author": "rules",
                    }
                )
        if mail_state != "available":
            limitations.append(
                "El correo no está disponible o su última sincronización no es reciente; "
                "no se supone un buzón vacío."
            )
        agent_summary = {"active": 0, "attention": 0, "unknown": 0}
        for item in observations[:100]:
            ref = f"agent:{item['observer_id']}"
            state = item["effective_status"]
            sources.append(
                {
                    "id": ref,
                    "kind": "agent_observation",
                    "status": "stale" if item["is_stale"] else "available",
                    "as_of": item["observed_at"],
                    "description": f"{item['agent']} en {item['workspace']}: {state}",
                }
            )
            if state == "active":
                agent_summary["active"] += 1
            elif state in {"waiting_permission", "waiting_input", "error", "retrying"}:
                agent_summary["attention"] += 1
                reasons = {
                    "waiting_permission": "Hay un permiso pendiente; requiere tu decisión.",
                    "waiting_input": "La sesión espera una respuesta tuya.",
                    "error": "La fuente reporta un error; revisa su causa antes de repetir.",
                    "retrying": "Hay reintentos; revisa conexión y presupuesto si persisten.",
                }
                if len(recommendations) < 8:
                    recommendations.append(
                        {
                            "title": f"Revisar {item['agent']}: {item['workspace']}"[:250],
                            "reason": reasons[state],
                            "evidence_refs": [ref],
                            "author": "rules",
                        }
                    )
            elif state == "unknown":
                agent_summary["unknown"] += 1
        if not observations:
            limitations.append("Todavía no hay sesiones observadas de Claude Code/OpenCode.")
        reliable_observations = any(
            not item["is_stale"]
            and item["effective_status"] != "unknown"
            and item["confidence"] != "low"
            for item in observations
        )
        if observations and not reliable_observations:
            limitations.append(
                "Las observaciones de agentes están vencidas o no permiten confirmar su estado."
            )
        plan: dict[str, Any] = {
            "date": selected,
            "timezone": TIMEZONE,
            "revision": 1,
            "generated_at": now,
            "updated_at": now,
            "status": "partial"
            if mail_state != "available" or not reliable_observations
            else "ready",
            "summary": (
                f"Tienes {len(tasks)} compromisos abiertos y "
                f"{agent_summary['attention']} sesiones que requieren atención."
            ),
            "priorities": priorities,
            "recommendations": recommendations[:8],
            "sources": sources,
            "mail_summary": mail_summary,
            "agent_summary": agent_summary,
            "limitations": limitations,
            "model": None,
            "model_error": None,
            "verification": "not_run",
        }
        with self.db.transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO daily_plans VALUES (?,?,?,?)",
                (selected, 1, json.dumps(plan, ensure_ascii=False), now),
            )
            row = connection.execute(
                "SELECT payload FROM daily_plans WHERE date=?", (selected,)
            ).fetchone()
        return dict(json.loads(row["payload"]))

    def recommend(self, selected: str, payload: PlanRecommendations) -> dict[str, Any]:
        with self.db.transaction() as connection:
            row = connection.execute(
                "SELECT payload FROM daily_plans WHERE date=?", (selected,)
            ).fetchone()
            if not row:
                raise ServiceError(404, "El plan del día todavía no existe.")
            plan = json.loads(row["payload"])
            if plan["revision"] != payload.expected_revision:
                raise ServiceError(409, "El plan cambió; relee antes de recomendar.")
            evidence = {item["id"] for item in plan["sources"]}
            if any(
                ref not in evidence for rec in payload.recommendations for ref in rec.evidence_refs
            ):
                raise ServiceError(422, "La recomendación debe citar fuentes presentes en el plan.")
            plan.update(
                summary=payload.summary,
                model=payload.model,
                model_error=None,
                recommendations=[
                    {**item.model_dump(), "author": "hermes"} for item in payload.recommendations
                ],
                revision=plan["revision"] + 1,
                updated_at=utc_now(),
            )
            connection.execute(
                "UPDATE daily_plans SET revision=?,payload=?,updated_at=? WHERE date=?",
                (
                    plan["revision"],
                    json.dumps(plan, ensure_ascii=False),
                    plan["updated_at"],
                    selected,
                ),
            )
        return dict(plan)

    def claim(self, selected: str, kind: Literal["open", "model"], payload: PlanClaim) -> bool:
        with self.db.transaction() as connection:
            if not connection.execute(
                "SELECT 1 FROM daily_plans WHERE date=?", (selected,)
            ).fetchone():
                raise ServiceError(404, "El plan del día todavía no existe.")
            result = connection.execute(
                "INSERT OR IGNORE INTO daily_plan_claims VALUES (?,?,?,?,?)",
                (selected, kind, payload.owner, payload.attempt_id, utc_now()),
            )
            return result.rowcount == 1

    def model_error(self, selected: str, error: ModelError) -> dict[str, Any]:
        with self.db.transaction() as connection:
            row = connection.execute(
                "SELECT payload FROM daily_plans WHERE date=?", (selected,)
            ).fetchone()
            if not row:
                raise ServiceError(404, "El plan del día todavía no existe.")
            plan = json.loads(row["payload"])
            if not plan["model"]:
                plan.update(model_error=error, revision=plan["revision"] + 1, updated_at=utc_now())
                connection.execute(
                    "UPDATE daily_plans SET revision=?,payload=?,updated_at=? WHERE date=?",
                    (
                        plan["revision"],
                        json.dumps(plan, ensure_ascii=False),
                        plan["updated_at"],
                        selected,
                    ),
                )
        return dict(plan)
