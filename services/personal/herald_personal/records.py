"""Human records have no automatic mail or executable side effects."""

import hashlib
import json
import sqlite3
from datetime import date
from typing import cast
from uuid import uuid4

from .database import Database
from .errors import ServiceError
from .models import Checkin, CheckinInput, Task, TaskCreate, TaskPatch, TaskStatus, utc_now


def json_text(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def digest(value: object) -> str:
    return hashlib.sha256(json_text(value).encode()).hexdigest()


def literal_pattern(query: str) -> str:
    return "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def task_row(connection: sqlite3.Connection, identifier: str) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM tasks WHERE id=?", (identifier,)).fetchone()
    if row is None:
        raise ServiceError(404, "Compromiso no encontrado.")
    return cast(sqlite3.Row, row)


class Records:
    def __init__(self, database: Database):
        self.db = database

    def create_task(self, payload: TaskCreate, *, verified_mail_source: str | None = None) -> Task:
        external_mail = (
            payload.source_type == "mail"
            and verified_mail_source is not None
            and payload.source_id == verified_mail_source
        )
        values = payload.model_dump(exclude={"idempotency_key"})
        payload_hash = digest(values)
        with self.db.transaction() as connection:
            if payload.idempotency_key:
                replay = connection.execute(
                    "SELECT * FROM idempotency WHERE key=?", (payload.idempotency_key,)
                ).fetchone()
                if replay:
                    if replay["payload_hash"] != payload_hash:
                        raise ServiceError(409, "La clave de idempotencia ya tiene otro contenido.")
                    return Task.model_validate_json(replay["result"])
            if payload.source_type == "mail" and not external_mail:
                mail = connection.execute(
                    "SELECT id FROM mail WHERE id=?", (payload.source_id,)
                ).fetchone()
                if mail is None:
                    raise ServiceError(404, "Correo de origen no encontrado.")
            existing = (
                connection.execute(
                    "SELECT * FROM tasks WHERE source_type=? AND source_id=?",
                    (payload.source_type, payload.source_id),
                ).fetchone()
                if payload.source_id
                else None
            )
            if existing:
                result = Task.model_validate(dict(existing))
            else:
                now, identifier = utc_now(), str(uuid4())
                result = Task(
                    **values,
                    id=identifier,
                    agent_task_id=None,
                    created_at=now,
                    updated_at=now,
                    revision=1,
                )
                connection.execute(
                    "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    tuple(result.model_dump().values()),
                )
                connection.execute(
                    "INSERT INTO task_events VALUES (?,?,?,?,?)",
                    (str(uuid4()), identifier, "created", now, json_text(values)),
                )
                if payload.source_type == "mail" and not external_mail:
                    connection.execute(
                        "UPDATE mail SET task_id=? WHERE id=?", (identifier, payload.source_id)
                    )
            if payload.idempotency_key:
                connection.execute(
                    "INSERT INTO idempotency VALUES (?,?,?)",
                    (payload.idempotency_key, payload_hash, result.model_dump_json()),
                )
            return result

    def get_task(self, identifier: str) -> Task:
        with self.db.connection() as connection:
            return Task.model_validate(dict(task_row(connection, identifier)))

    def tasks(self, status: TaskStatus | None = None, query: str = "") -> list[Task]:
        with self.db.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM tasks WHERE (? IS NULL OR status=?) "
                "AND (title LIKE ? ESCAPE '\\' OR COALESCE(description,'') LIKE ? ESCAPE '\\') "
                "ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, "
                "due_at IS NULL, due_at, created_at DESC",
                (status, status, literal_pattern(query), literal_pattern(query)),
            ).fetchall()
            return [Task.model_validate(dict(row)) for row in rows]

    def patch_task(self, identifier: str, payload: TaskPatch) -> Task:
        changes = payload.model_dump(exclude_unset=True, exclude={"expected_revision"})
        with self.db.transaction() as connection:
            previous = dict(task_row(connection, identifier))
            if previous["revision"] != payload.expected_revision:
                raise ServiceError(409, "El compromiso cambió. Recargue antes de guardar.")
            now = utc_now()
            updated = Task.model_validate(
                {
                    **previous,
                    **changes,
                    "updated_at": now,
                    "revision": payload.expected_revision + 1,
                }
            )
            connection.execute(
                "UPDATE tasks SET title=?,description=?,status=?,priority=?,due_at=?,project=?,"
                "updated_at=?,revision=? WHERE id=? AND revision=?",
                (
                    updated.title,
                    updated.description,
                    updated.status,
                    updated.priority,
                    updated.due_at,
                    updated.project,
                    now,
                    updated.revision,
                    identifier,
                    payload.expected_revision,
                ),
            )
            connection.execute(
                "INSERT INTO task_events VALUES (?,?,?,?,?)",
                (
                    str(uuid4()),
                    identifier,
                    "updated",
                    now,
                    json_text(
                        {
                            "before": {key: previous[key] for key in changes},
                            "after": changes,
                            "revision": updated.revision,
                        }
                    ),
                ),
            )
            return updated

    def task_events(self, identifier: str) -> list[dict[str, str]]:
        with self.db.connection() as connection:
            task_row(connection, identifier)
            rows = connection.execute(
                "SELECT id,kind,created_at,detail FROM task_events WHERE task_id=? ORDER BY rowid",
                (identifier,),
            ).fetchall()
            return [dict(row) for row in rows]

    def checkins(self) -> list[Checkin]:
        with self.db.connection() as connection:
            return [
                Checkin.model_validate(dict(row))
                for row in connection.execute(
                    "SELECT * FROM checkins ORDER BY date DESC"
                ).fetchall()
            ]

    def save_checkin(self, local_date: str, payload: CheckinInput) -> Checkin:
        try:
            if date.fromisoformat(local_date).isoformat() != local_date:
                raise ValueError
        except ValueError as error:
            raise ServiceError(422, "Use una fecha local válida YYYY-MM-DD.") from error
        with self.db.transaction() as connection:
            previous = connection.execute(
                "SELECT * FROM checkins WHERE date=?", (local_date,)
            ).fetchone()
            now = utc_now()
            entry = Checkin(
                **payload.model_dump(),
                id=previous["id"] if previous else str(uuid4()),
                date=local_date,
                created_at=previous["created_at"] if previous else now,
                updated_at=now,
            )
            connection.execute(
                "INSERT INTO checkins(id,date,accomplished,pending,tomorrow,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET "
                "accomplished=excluded.accomplished,"
                "pending=excluded.pending,tomorrow=excluded.tomorrow,updated_at=excluded.updated_at",
                (
                    entry.id,
                    entry.date,
                    entry.accomplished,
                    entry.pending,
                    entry.tomorrow,
                    entry.created_at,
                    now,
                ),
            )
            connection.execute(
                "INSERT INTO checkin_events VALUES (?,?,?,?)",
                (str(uuid4()), entry.id, now, entry.model_dump_json()),
            )
            return entry
