"""Durable project read model shared by the dashboard and agent tools.

Execution, PR integration and independently verified delivery are separate facts.
Only an authenticated source snapshot owns imported task fields; dates are retained.
"""

import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Self
from uuid import uuid4

from fastapi import FastAPI, Path
from pydantic import Field, field_validator, model_validator

from .database import Database
from .errors import ServiceError
from .models import InputModel, Task, Title, utc_now
from .records import digest, json_text

Key = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")]
Repository = Annotated[
    str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$", max_length=200)
]
RunStatus = Literal["queued", "running", "completed", "failed", "cancelled", "unknown"]


def aware(value: str | None) -> str | None:
    if value is not None and datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
        raise ValueError("La fecha de origen debe incluir zona horaria.")
    return value


def epoch(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


class PullRequest(InputModel):
    repository: Repository
    number: int = Field(strict=True, ge=1, le=100_000_000)
    state: Literal["OPEN", "MERGED", "CLOSED"]
    updated_at: str = Field(max_length=50)

    _date = field_validator("updated_at")(aware)


class ProjectInputItem(InputModel):
    key: Key
    title: Title
    run_id: Key | None = None
    run_status: RunStatus = "unknown"
    branch: str | None = Field(default=None, max_length=300)
    pr: PullRequest | None = None


class ProjectSnapshot(InputModel):
    project: Title
    label: Title
    attempted_at: str = Field(max_length=50)
    source_updated_at: str | None = Field(default=None, max_length=50)
    interval_seconds: int = Field(default=900, ge=30, le=86400)
    error: Literal["source_unavailable", "source_invalid"] | None = None
    github_error: bool = False
    warnings: list[Annotated[str, Field(max_length=500)]] = Field(
        default_factory=list, max_length=20
    )
    items: list[ProjectInputItem] = Field(default_factory=list, max_length=200)

    _dates = field_validator("attempted_at", "source_updated_at")(aware)

    @model_validator(mode="after")
    def coherent(self) -> Self:
        if epoch(self.attempted_at) > datetime.now(UTC).timestamp() + 60:
            raise ValueError("La consulta no puede estar en el futuro.")
        if len({item.key for item in self.items}) != len(self.items):
            raise ValueError("Identificadores repetidos en una misma consulta.")
        if self.error and self.items:
            raise ValueError("Una consulta fallida no reemplaza la evidencia guardada.")
        return self


def source_health(source: dict[str, Any], now: float) -> str:
    if source["error"]:
        return "error"
    payload = source["payload"]
    if now - epoch(source["last_attempt_at"]) > payload["interval_seconds"] * 2 + 60:
        return "stale"
    if payload["github_error"]:
        return "partial"
    return "ok"


def run_is_fresh(source: dict[str, Any], now: float) -> bool:
    value = source["payload"]["source_updated_at"]
    if not value or source_health(source, now) in {"stale", "error"}:
        return False
    age = now - epoch(value)
    return bool(-60 <= age <= source["payload"]["interval_seconds"] * 2 + 60)


def stage_for(item: dict[str, Any], fresh: bool, present: bool) -> tuple[str, str]:
    pr = item.get("pr")
    if pr and pr["state"] == "MERGED":
        return (
            "integrated",
            "PR integrado. Despliegue y validación funcional pendientes de evidencia.",
        )
    if not present:
        return "unknown", "Esta ejecución ya no aparece en la última consulta del origen."
    if pr and pr["state"] == "OPEN":
        return "review", "PR abierto: revisar cambios y comprobaciones antes de integrarlo."
    if pr and pr["state"] == "CLOSED":
        return "attention", "PR cerrado sin integrar. Revisar cómo continuar este trabajo."
    status = item["run_status"]
    if status == "completed":
        return "attention", "El proceso terminó; falta un PR o evidencia de entrega vinculada."
    if status == "failed":
        return (
            "attention",
            "La ejecución informó un fallo. Revisar su resultado antes de reintentar.",
        )
    if status == "cancelled":
        return "cancelled", "Ejecución cancelada; no confirma una entrega."
    if status in {"running", "queued"} and fresh:
        return (
            ("running", "Ejecución informada por el origen.")
            if status == "running"
            else ("planned", "Ejecución en cola en el origen.")
        )
    return "unknown", "Sin señal reciente y fechada para confirmar una ejecución activa."


class Projects:
    def __init__(self, database: Database):
        self.db = database

    def ingest(self, source_id: str, snapshot: ProjectSnapshot) -> dict[str, Any]:
        metadata = snapshot.model_dump(exclude={"items"})
        metadata["snapshot_hash"] = digest(snapshot.model_dump())
        now = utc_now()
        with self.db.transaction() as connection:
            previous = connection.execute(
                "SELECT * FROM project_sources WHERE source_id=?", (source_id,)
            ).fetchone()
            if previous:
                if previous["project"] != snapshot.project:
                    raise ServiceError(409, "El origen ya pertenece a otro proyecto.")
                if epoch(previous["last_attempt_at"]) > epoch(snapshot.attempted_at):
                    raise ServiceError(409, "Se recibió una consulta anterior a la guardada.")
                if (
                    epoch(previous["last_attempt_at"]) == epoch(snapshot.attempted_at)
                    and json.loads(previous["payload"])["snapshot_hash"]
                    != metadata["snapshot_hash"]
                ):
                    raise ServiceError(409, "Esta consulta ya se recibió con otro contenido.")
            last_success = previous["last_success_at"] if previous else None
            if not snapshot.error:
                last_success = snapshot.attempted_at
            connection.execute(
                "INSERT INTO project_sources VALUES (?,?,?,?,?,?) ON CONFLICT(source_id) "
                "DO UPDATE SET payload=excluded.payload,last_attempt_at=excluded.last_attempt_at,"
                "last_success_at=excluded.last_success_at,error=excluded.error",
                (
                    source_id,
                    snapshot.project,
                    json_text(metadata),
                    snapshot.attempted_at,
                    last_success,
                    snapshot.error,
                ),
            )
            if not snapshot.error:
                connection.execute(
                    "UPDATE project_items SET present=0 WHERE source_id=? "
                    "AND (?=0 OR json_extract(payload,'$.run_id') IS NOT NULL)",
                    (source_id, snapshot.github_error),
                )
                for item in snapshot.items:
                    stored = connection.execute(
                        "SELECT * FROM project_items WHERE source_id=? AND external_id=?",
                        (source_id, item.key),
                    ).fetchone()
                    evidence = item.model_dump()
                    evidence["pr_checked_at"] = (
                        None if snapshot.github_error else snapshot.attempted_at
                    )
                    if snapshot.github_error and stored:
                        old = json.loads(stored["payload"])
                        evidence["pr"], evidence["pr_checked_at"] = old["pr"], old["pr_checked_at"]
                    task_id = self._upsert_task(connection, source_id, snapshot, evidence, now)
                    connection.execute(
                        "INSERT INTO project_items VALUES (?,?,?,?,1) "
                        "ON CONFLICT(source_id,external_id) "
                        "DO UPDATE SET payload=excluded.payload,present=1",
                        (source_id, item.key, task_id, json_text(evidence)),
                    )
        return {
            "source_id": source_id,
            "accepted": True,
            "items": len(snapshot.items),
            "error": snapshot.error,
        }

    def _upsert_task(
        self,
        connection: sqlite3.Connection,
        source_id: str,
        snapshot: ProjectSnapshot,
        evidence: dict[str, Any],
        now: str,
    ) -> str:
        existing = connection.execute(
            "SELECT * FROM tasks WHERE source_type='agent' AND source_id=?", (evidence["key"],)
        ).fetchone()
        if existing:
            owner = connection.execute(
                "SELECT source_id FROM project_items WHERE task_id=?", (existing["id"],)
            ).fetchone()
            if existing["project"] != snapshot.project or (
                owner and owner["source_id"] != source_id
            ):
                raise ServiceError(409, "La referencia ya está vinculada a otro origen o proyecto.")
        stage, reason = stage_for(
            evidence,
            fresh=snapshot.source_updated_at is not None
            and -60
            <= epoch(now) - epoch(snapshot.source_updated_at)
            <= snapshot.interval_seconds * 2 + 60,
            present=True,
        )
        status = {
            "integrated": "done",
            "running": "in_progress",
            "planned": "next",
            "cancelled": "cancelled",
        }.get(stage, "waiting")
        pr = evidence["pr"]
        description = f"Seguimiento: {snapshot.label}. {reason}"
        if pr:
            description += (
                f" PR #{pr['number']}: https://github.com/{pr['repository']}/pull/{pr['number']}"
            )
        changes = {
            "title": evidence["title"],
            "description": description,
            "status": status,
            "priority": "high" if stage in {"attention", "unknown"} else "normal",
        }
        if existing:
            changed = {key: value for key, value in changes.items() if existing[key] != value}
            if changed:
                connection.execute(
                    "UPDATE tasks SET title=?,description=?,status=?,priority=?,"
                    "revision=revision+1,updated_at=? WHERE id=?",
                    (*changes.values(), now, existing["id"]),
                )
                connection.execute(
                    "INSERT INTO task_events VALUES (?,?,?,?,?)",
                    (
                        str(uuid4()),
                        existing["id"],
                        "updated",
                        now,
                        json_text(
                            {
                                "before": {key: existing[key] for key in changed},
                                "after": changed,
                                "revision": existing["revision"] + 1,
                                "source_id": source_id,
                            }
                        ),
                    ),
                )
            return str(existing["id"])
        identifier = str(uuid4())
        task = Task.model_validate(
            {
                **changes,
                "id": identifier,
                "project": snapshot.project,
                "source_type": "agent",
                "source_id": evidence["key"],
                "agent_task_id": None,
                "due_at": None,
                "created_at": now,
                "updated_at": now,
                "revision": 1,
            }
        )
        connection.execute(
            "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            tuple(task.model_dump().values()),
        )
        connection.execute(
            "INSERT INTO task_events VALUES (?,?,?,?,?)",
            (str(uuid4()), identifier, "created", now, task.model_dump_json()),
        )
        return identifier

    def list(self) -> dict[str, Any]:
        now = utc_now()
        with self.db.connection() as connection:
            tasks = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM tasks WHERE project IS NOT NULL AND TRIM(project) != '' "
                    "ORDER BY title COLLATE NOCASE"
                )
            ]
            sources = {
                row["source_id"]: {**dict(row), "payload": json.loads(row["payload"])}
                for row in connection.execute("SELECT * FROM project_sources ORDER BY source_id")
            }
            evidence = {
                row["task_id"]: {**dict(row), "payload": json.loads(row["payload"])}
                for row in connection.execute("SELECT * FROM project_items")
            }
            names = sorted(
                {task["project"] for task in tasks} | {s["project"] for s in sources.values()}
            )
            result = []
            for name in names:
                items = []
                for task in (t for t in tasks if t["project"] == name):
                    record = evidence.get(task["id"])
                    if record:
                        source = sources[record["source_id"]]
                        item = record["payload"].copy()
                        fresh = run_is_fresh(source, epoch(now))
                        stage, reason = stage_for(item, fresh, bool(record["present"]))
                        item.update(
                            {
                                "stage": stage,
                                "reason": reason,
                                "missing": not bool(record["present"]),
                                "source_id": record["source_id"],
                                "run_fresh": fresh,
                                "source_updated_at": source["payload"]["source_updated_at"],
                            }
                        )
                        if item["pr"]:
                            pr = item["pr"]
                            pr["url"] = f"https://github.com/{pr['repository']}/pull/{pr['number']}"
                    else:
                        item = {
                            "key": task["id"],
                            "stage": {
                                "done": "completed",
                                "cancelled": "cancelled",
                                "in_progress": "running",
                                "waiting": "attention",
                            }.get(task["status"], "planned"),
                            "reason": "Estado del compromiso personal.",
                            "pr": None,
                            "pr_checked_at": None,
                            "run_id": None,
                            "run_status": "unknown",
                            "branch": None,
                            "source_id": None,
                            "run_fresh": False,
                            "missing": False,
                            "source_updated_at": None,
                        }
                    items.append({**item, "task": task, "verification": "not_run"})
                counts = {
                    "total": len(items),
                    "closed": sum(i["stage"] in {"integrated", "completed"} for i in items),
                    "running": sum(i["stage"] == "running" for i in items),
                    "attention": sum(i["stage"] in {"attention", "unknown"} for i in items),
                    "review": sum(i["stage"] == "review" for i in items),
                    "merged": sum(bool(i["pr"] and i["pr"]["state"] == "MERGED") for i in items),
                }
                public_sources = []
                for source in (s for s in sources.values() if s["project"] == name):
                    payload = source["payload"]
                    public_sources.append(
                        {
                            "id": source["source_id"],
                            "label": payload["label"],
                            "interval_seconds": payload["interval_seconds"],
                            "health": source_health(source, epoch(now)),
                            "last_attempt_at": source["last_attempt_at"],
                            "last_success_at": source["last_success_at"],
                            "source_updated_at": payload["source_updated_at"],
                            "run_fresh": run_is_fresh(source, epoch(now)),
                            "error": source["error"],
                            "github_error": payload["github_error"],
                            "warnings": payload["warnings"],
                        }
                    )
                events = [
                    dict(row)
                    for row in connection.execute(
                        "SELECT e.id,e.kind,e.created_at,e.detail,e.task_id,t.title "
                        "FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.project=? "
                        "ORDER BY e.created_at DESC,e.rowid DESC LIMIT 8",
                        (name,),
                    )
                ]
                result.append(
                    {
                        "id": hashlib.sha256(name.encode()).hexdigest()[:24],
                        "name": name,
                        "counts": counts,
                        "items": items,
                        "sources": public_sources,
                        "events": events,
                    }
                )
        return {"items": result, "as_of": now}


def attach_project_routes(app: FastAPI, projects: Projects) -> None:
    @app.get("/v1/projects")
    def list_projects() -> dict[str, Any]:
        return projects.list()

    @app.put("/v1/project-sources/{source_id}")
    def sync_project(
        snapshot: ProjectSnapshot,
        source_id: Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")],
    ) -> dict[str, Any]:
        return projects.ingest(source_id, snapshot)
