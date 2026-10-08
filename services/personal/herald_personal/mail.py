"""Mail snapshot persistence and durable intent records around provider writes."""

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Literal
from uuid import uuid4

from .database import Database
from .errors import ServiceError
from .models import (
    CaptureInput,
    MailCategory,
    MailThread,
    MailThreadPage,
    ProviderName,
    ProviderStatus,
    Task,
    TaskCreate,
    utc_now,
)
from .providers.base import DraftResult, MailProvider, MutationResult, ProviderError, SyncBatch
from .records import Records, digest, json_text, literal_pattern

MAIL_PAGE_BYTES = 1024 * 1024
MAIL_PAGE_METADATA_BYTES = 8192


class MailService:
    def __init__(self, db: Database, records: Records, providers: dict[ProviderName, MailProvider]):
        self.db, self.records, self.providers = db, records, providers
        self._locks = {name: threading.Lock() for name in providers}

    @contextmanager
    def _exclusive(self, name: ProviderName) -> Iterator[MailProvider]:
        provider = self.providers[name]
        if not provider.configured:
            raise ServiceError(503, "Configure las credenciales del proveedor antes de continuar.")
        lock = self._locks[name]
        if not lock.acquire(blocking=False):
            raise ServiceError(409, "Ya hay una operación en curso para este proveedor.")
        try:
            yield provider
        finally:
            lock.release()

    def statuses(self) -> list[ProviderStatus]:
        result = []
        with self.db.connection() as connection:
            for name, provider in self.providers.items():
                row = connection.execute(
                    "SELECT * FROM provider_state WHERE provider=?", (name,)
                ).fetchone()
                configured = provider.configured
                error = row["error"] if row else None
                last_sync = row["last_sync_at"] if row else None
                if not configured:
                    error = "Configure una credencial de lectura para este proveedor."
                result.append(
                    ProviderStatus(
                        provider=name,
                        configured=configured,
                        connected=configured and bool(last_sync) and error is None,
                        last_sync_at=last_sync,
                        error=error,
                    )
                )
        return result

    def _sync_failed(self, name: ProviderName, error: ProviderError) -> None:
        with self.db.transaction() as connection:
            connection.execute(
                "INSERT INTO provider_state(provider,error) VALUES (?,?) "
                "ON CONFLICT(provider) DO UPDATE SET error=excluded.error",
                (name, str(error)),
            )

    def sync(self, name: ProviderName) -> int:
        with self._exclusive(name) as provider:
            with self.db.connection() as connection:
                state = connection.execute(
                    "SELECT cursor FROM provider_state WHERE provider=?", (name,)
                ).fetchone()
            try:
                batch = provider.sync(state["cursor"] if state else None)
            except ProviderError as error:
                self._sync_failed(name, error)
                raise ServiceError(502, str(error)) from error
            self._save_batch(name, batch)
            return len(batch.messages)

    def _save_batch(self, name: ProviderName, batch: SyncBatch) -> None:
        with self.db.transaction() as connection:
            for message in batch.messages:
                connection.execute(
                    "INSERT INTO mail(id,provider,provider_id,subject,sender,preview,body,"
                    "received_at,"
                    "category,unread,web_url,archived,location) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(provider,provider_id) DO UPDATE SET subject=excluded.subject,"
                    "sender=excluded.sender,preview=excluded.preview,body=excluded.body,"
                    "received_at=excluded.received_at,unread=excluded.unread,web_url=excluded.web_url,"
                    "archived=excluded.archived,location=excluded.location,"
                    "category=CASE WHEN mail.category_manual=1 THEN mail.category "
                    "ELSE excluded.category END",
                    (
                        str(uuid4()),
                        name,
                        message.provider_id,
                        message.subject,
                        message.sender,
                        message.preview,
                        message.body,
                        message.received_at,
                        message.category,
                        int(message.unread),
                        message.web_url,
                        int(message.archived),
                        json_text(message.location),
                    ),
                )
            for identifier in batch.removed_ids:
                connection.execute(
                    "UPDATE mail SET archived=1 WHERE provider=? AND provider_id=?",
                    (name, identifier),
                )
            if batch.snapshot_ids is not None:
                connection.execute("UPDATE mail SET archived=1 WHERE provider=?", (name,))
                connection.executemany(
                    "UPDATE mail SET archived=0 WHERE provider=? AND provider_id=?",
                    [(name, identifier) for identifier in batch.snapshot_ids],
                )
            connection.execute(
                "INSERT INTO provider_state(provider,cursor,last_sync_at,error) "
                "VALUES (?,?,?,NULL) "
                "ON CONFLICT(provider) DO UPDATE SET cursor=excluded.cursor,"
                "last_sync_at=excluded.last_sync_at,error=NULL",
                (name, batch.cursor, utc_now()),
            )

    def get(self, identifier: str) -> dict[str, Any]:
        with self.db.connection() as connection:
            row = connection.execute("SELECT * FROM mail WHERE id=?", (identifier,)).fetchone()
            if row is None:
                raise ServiceError(404, "Correo no encontrado.")
            return dict(row)

    def urgent_count(self) -> int:
        with self.db.connection() as connection:
            return int(
                connection.execute(
                    "SELECT COUNT(*) FROM mail WHERE category='urgent' AND archived=0"
                ).fetchone()[0]
            )

    def threads(
        self,
        query: str = "",
        category: MailCategory | None = None,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> MailThreadPage:
        filters = (
            "WHERE (? IS NULL OR category=?) AND "
            "(subject LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\' "
            "OR preview LIKE ? ESCAPE '\\') "
        )
        parameters = (category, category, *([literal_pattern(query)] * 3))
        with self.db.connection() as connection:
            connection.execute("BEGIN")
            total = int(
                connection.execute("SELECT COUNT(*) FROM mail " + filters, parameters).fetchone()[0]
            )
            rows = connection.execute(
                "SELECT * FROM mail " + filters + "ORDER BY received_at DESC, id LIMIT ? OFFSET ?",
                (*parameters, limit + 1, offset),
            ).fetchall()
        items: list[MailThread] = []
        used_bytes = MAIL_PAGE_METADATA_BYTES
        for row in rows[:limit]:
            item = MailThread.model_validate(dict(row))
            item_bytes = len(item.model_dump_json().encode("utf-8")) + 1
            if used_bytes + item_bytes > MAIL_PAGE_BYTES:
                if not items:
                    raise ServiceError(503, "Un correo excede el tamaño permitido para la página.")
                break
            items.append(item)
            used_bytes += item_bytes
        return MailThreadPage(
            items=items,
            providers=self.statuses(),
            total=total,
            offset=offset,
            next_offset=offset + len(items) if len(rows) > len(items) else None,
        )

    def categorize(self, identifier: str, category: MailCategory) -> MailThread:
        previous = self.get(identifier)
        with self.db.transaction() as connection:
            connection.execute(
                "UPDATE mail SET category=?,category_manual=1 WHERE id=?", (category, identifier)
            )
            connection.execute(
                "INSERT INTO mail_events VALUES (?,?,?,?,?)",
                (
                    str(uuid4()),
                    identifier,
                    "categorized",
                    utc_now(),
                    json_text({"before": previous["category"], "after": category}),
                ),
            )
        return MailThread.model_validate(self.get(identifier))

    def capture(self, identifier: str, payload: CaptureInput) -> Task:
        message = self.get(identifier)
        return self.records.create_task(
            TaskCreate(
                title=payload.title or message["subject"],
                description=message["body"],
                source_type="mail",
                source_id=identifier,
                priority=payload.priority,
                due_at=payload.due_at,
            )
        )

    def _existing_action(
        self, identifier: str, kind: str, fingerprint: str = ""
    ) -> dict[str, Any] | None:
        with self.db.connection() as connection:
            row = connection.execute(
                "SELECT * FROM mail_actions WHERE mail_id=? AND kind=? "
                "AND (?='' OR fingerprint=?) ORDER BY rowid DESC LIMIT 1",
                (identifier, kind, fingerprint, fingerprint),
            ).fetchone()
            if row is None or row["state"] in {"failed", "restored"}:
                return None
            if row["state"] != "completed":
                raise ServiceError(
                    409, "Hay una operación sin confirmar. Revise el buzón antes de repetirla."
                )
            return dict(row)

    def _begin_action(
        self, identifier: str, kind: str, previous: dict[str, Any], fingerprint: str = ""
    ) -> str:
        action_id, now = str(uuid4()), utc_now()
        with self.db.transaction() as connection:
            connection.execute(
                "INSERT INTO mail_actions VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    action_id,
                    identifier,
                    kind,
                    fingerprint,
                    "pending",
                    json_text(previous),
                    None,
                    now,
                    now,
                ),
            )
            connection.execute(
                "INSERT INTO mail_events VALUES (?,?,?,?,?)",
                (
                    str(uuid4()),
                    identifier,
                    kind + "_requested",
                    now,
                    json_text({"action_id": action_id}),
                ),
            )
        return action_id

    def _action_failed(self, action_id: str, error: ProviderError) -> None:
        with self.db.transaction() as connection:
            connection.execute(
                "UPDATE mail_actions SET state=?,updated_at=? WHERE id=?",
                (
                    "uncertain" if error.uncertain or error.code in {401, 403} else "failed",
                    utc_now(),
                    action_id,
                ),
            )

    def draft(self, identifier: str, body: str) -> DraftResult:
        mail = self.get(identifier)
        with self._exclusive(mail["provider"]) as provider:
            fingerprint = digest(body)
            existing = self._existing_action(identifier, "draft", fingerprint)
            if existing:
                return DraftResult.model_validate_json(existing["result"])
            action_id = self._begin_action(identifier, "draft", {}, fingerprint)
            try:
                result = provider.create_draft(mail["provider_id"], body)
            except ProviderError as error:
                self._action_failed(action_id, error)
                raise ServiceError(502, str(error)) from error
            with self.db.transaction() as connection:
                connection.execute(
                    "UPDATE mail_actions SET state='completed',result=?,updated_at=? WHERE id=?",
                    (
                        result.model_dump_json(),
                        utc_now(),
                        action_id,
                    ),
                )
            return result

    def archive(self, identifier: str) -> dict[str, str | bool]:
        mail = self.get(identifier)
        with self._exclusive(mail["provider"]) as provider:
            existing = self._existing_action(identifier, "archive")
            if existing:
                return {"action_id": existing["id"], "archived": True}
            try:
                previous = provider.inspect(mail["provider_id"])
            except ProviderError as error:
                raise ServiceError(502, str(error)) from error
            action_id = self._begin_action(identifier, "archive", previous)
            try:
                result = provider.archive(mail["provider_id"], previous)
            except ProviderError as error:
                self._action_failed(action_id, error)
                raise ServiceError(502, str(error)) from error
            self._finish_move(action_id, identifier, result, "completed", True)
            return {"action_id": action_id, "archived": True}

    def _finish_move(
        self,
        action_id: str,
        identifier: str,
        result: MutationResult,
        state: Literal["completed", "restored"],
        archived: bool,
    ) -> None:
        with self.db.transaction() as connection:
            connection.execute(
                "UPDATE mail SET provider_id=?,location=?,archived=? WHERE id=?",
                (
                    result.provider_id,
                    json_text(result.location),
                    int(archived),
                    identifier,
                ),
            )
            connection.execute(
                "UPDATE mail_actions SET state=?,result=?,updated_at=? WHERE id=?",
                (
                    state,
                    result.model_dump_json(),
                    utc_now(),
                    action_id,
                ),
            )
            connection.execute(
                "INSERT INTO mail_events VALUES (?,?,?,?,?)",
                (
                    str(uuid4()),
                    identifier,
                    "archive_" + state,
                    utc_now(),
                    json_text({"action_id": action_id}),
                ),
            )

    def undo(self, action_id: str) -> dict[str, bool]:
        with self.db.connection() as connection:
            row = connection.execute(
                "SELECT * FROM mail_actions WHERE id=? AND kind='archive'", (action_id,)
            ).fetchone()
            if row is None:
                raise ServiceError(404, "Acción de archivo no encontrada.")
            action = dict(row)
        if action["state"] == "restored":
            return {"restored": True}
        if action["state"] != "completed":
            raise ServiceError(
                409, "La acción no está confirmada. Revise el buzón antes de deshacer."
            )
        mail = self.get(action["mail_id"])
        with self._exclusive(mail["provider"]) as provider:
            with self.db.transaction() as connection:
                changed = connection.execute(
                    "UPDATE mail_actions SET state='undoing',updated_at=? "
                    "WHERE id=? AND state='completed'",
                    (utc_now(), action_id),
                ).rowcount
                if changed != 1:
                    raise ServiceError(409, "La acción ya cambió. Recargue el registro.")
            result = MutationResult.model_validate_json(action["result"])
            try:
                restored = provider.restore(
                    result.provider_id, json.loads(action["previous"]), result.location
                )
            except ProviderError as error:
                # A failed undo remains blocked until an operator reconciles its intent.
                with self.db.transaction() as connection:
                    connection.execute(
                        "UPDATE mail_actions SET state='uncertain',updated_at=? WHERE id=?",
                        (utc_now(), action_id),
                    )
                raise ServiceError(502, str(error)) from error
            self._finish_move(action_id, mail["id"], restored, "restored", False)
            return {"restored": True}
