"""Read-only coding run projections never execute or complete human tasks."""

from datetime import UTC, datetime
from typing import Annotated, Literal, Self
from uuid import UUID, uuid4

from pydantic import Field, field_validator, model_validator

from .database import Database
from .errors import ServiceError
from .models import InputModel, utc_now
from .records import digest, task_row

RunStatus = Literal[
    "queued",
    "running",
    "cancel_requested",
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "interrupted",
]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


def run_timestamp(value: str | None) -> str | None:
    if value is None:
        return None
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        raise ValueError("La fecha de ejecución requiere zona horaria.")
    return timestamp.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


class RunAttempt(InputModel):
    number: Annotated[int, Field(strict=True, ge=1, le=100)]
    status: RunStatus
    started_at: str
    finished_at: str | None
    exit_code: Annotated[int, Field(strict=True, ge=-255, le=255)] | None
    stdout_sha256: Sha256 | None
    stderr_sha256: Sha256 | None
    outcome: Annotated[str, Field(max_length=2000)] | None

    _timestamps = field_validator("started_at", "finished_at")(run_timestamp)

    @model_validator(mode="after")
    def ordered_times(self) -> Self:
        if self.finished_at and self.finished_at < self.started_at:
            raise ValueError("El intento termina antes de su inicio.")
        return self


class AgentRun(InputModel):
    run_id: str
    revision: Annotated[int, Field(strict=True, ge=1)]
    scope_id: Annotated[str, Field(min_length=1, max_length=200)]
    task_id: Annotated[str, Field(min_length=1, max_length=200)] | None
    workspace: Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")]
    agent: Literal["claude", "opencode"]
    status: RunStatus
    created_at: str
    updated_at: str
    verification: Literal["not_run"]
    attempts: list[RunAttempt] = Field(max_length=100)

    _timestamps = field_validator("created_at", "updated_at")(run_timestamp)

    @field_validator("run_id")
    @classmethod
    def canonical_id(cls, value: str) -> str:
        return str(UUID(value))

    @model_validator(mode="after")
    def valid_snapshot(self) -> Self:
        if self.updated_at < self.created_at:
            raise ValueError("La actualización precede a la creación.")
        numbers = [attempt.number for attempt in self.attempts]
        if numbers != sorted(set(numbers)):
            raise ValueError("Los intentos deben tener números únicos en orden.")
        if any(attempt.started_at < self.created_at for attempt in self.attempts):
            raise ValueError("Un intento precede a la ejecución.")
        return self


class AgentRuns:
    def __init__(self, database: Database):
        self.db = database

    def snapshots(self) -> list[AgentRun]:
        with self.db.connection() as connection:
            return [
                AgentRun.model_validate_json(row["payload"])
                for row in connection.execute(
                    "SELECT payload FROM agent_runs ORDER BY updated_at DESC,run_id"
                ).fetchall()
            ]

    def save(self, run_id: str, snapshot: AgentRun) -> AgentRun:
        if run_id != snapshot.run_id:
            raise ServiceError(422, "El identificador de la ruta no coincide con la ejecución.")
        hashed = digest(snapshot.model_dump())
        with self.db.transaction() as connection:
            previous = connection.execute(
                "SELECT * FROM agent_runs WHERE run_id=?", (run_id,)
            ).fetchone()
            if previous:
                if snapshot.revision < previous["revision"]:
                    raise ServiceError(409, "La ejecución ya tiene una revisión posterior.")
                if snapshot.revision == previous["revision"]:
                    if hashed != previous["payload_hash"]:
                        raise ServiceError(409, "La revisión ya existe con otro contenido.")
                    return AgentRun.model_validate_json(previous["payload"])
                old = AgentRun.model_validate_json(previous["payload"])
                identity = ("scope_id", "task_id", "workspace", "agent", "created_at")
                if any(getattr(old, field) != getattr(snapshot, field) for field in identity):
                    raise ServiceError(409, "La identidad de la ejecución no puede cambiar.")
                if snapshot.updated_at < old.updated_at:
                    raise ServiceError(409, "La fecha de actualización no puede retroceder.")
            if snapshot.task_id is not None:
                task_row(connection, snapshot.task_id)
            connection.execute(
                "INSERT INTO agent_runs VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET "
                "revision=excluded.revision,payload_hash=excluded.payload_hash,"
                "payload=excluded.payload,updated_at=excluded.updated_at",
                (
                    run_id,
                    snapshot.revision,
                    hashed,
                    snapshot.model_dump_json(),
                    snapshot.updated_at,
                ),
            )
            connection.execute(
                "INSERT INTO agent_run_events VALUES (?,?,?,?,?)",
                (
                    str(uuid4()),
                    run_id,
                    snapshot.revision,
                    utc_now(),
                    snapshot.model_dump_json(),
                ),
            )
        return snapshot
