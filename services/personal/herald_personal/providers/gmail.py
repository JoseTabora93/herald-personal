"""Gmail baseline/history sync, MIME reply drafts and reversible INBOX changes."""

import base64
import binascii
import re
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Any, Literal
from urllib.parse import quote

from pydantic import BaseModel, Field, ValidationError

from ..models import ProviderName
from .base import (
    DraftResult,
    MutationResult,
    ProviderError,
    ProviderHTTP,
    ProviderMessage,
    SyncBatch,
    category_for,
    plain_text,
    required_string,
)


class GmailHeader(BaseModel):
    name: str
    value: str


class GmailBody(BaseModel):
    data: str = ""


class GmailPart(BaseModel):
    mimeType: str = "text/plain"
    body: GmailBody = Field(default_factory=GmailBody)
    headers: list[GmailHeader] = Field(default_factory=list)
    parts: list["GmailPart"] = Field(default_factory=list)


class GmailMessage(BaseModel):
    id: str
    threadId: str
    labelIds: list[str] = Field(default_factory=list)
    snippet: str = ""
    internalDate: str
    payload: GmailPart


class GmailCursor(BaseModel):
    mode: Literal["baseline", "history"] = "baseline"
    history_id: str = Field(pattern=r"^\d+$", max_length=100)
    page_token: str | None = Field(default=None, max_length=4096)
    seen_ids: list[str] = Field(default_factory=list, max_length=10_000)


def decode_part(part: GmailPart, depth: int = 0) -> str:
    if depth > 20:
        raise ProviderError("El correo tiene demasiados niveles MIME.")
    if part.mimeType in {"text/plain", "text/html"} and part.body.data:
        try:
            encoded = part.body.data[:400_000]
            decoded = base64.b64decode(
                encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True
            )
            return plain_text(
                decoded.decode("utf-8", errors="replace"), part.mimeType == "text/html"
            )
        except (ValueError, binascii.Error) as error:
            raise ProviderError("El correo contiene un cuerpo MIME inválido.") from error
    ordered = sorted(part.parts, key=lambda item: item.mimeType != "text/plain")
    content = [decode_part(child, depth + 1) for child in ordered[:100]]
    if part.mimeType == "multipart/alternative":
        return next((text for text in content if text), "")
    return "\n".join(text for text in content if text)[:50_000]


class GmailProvider(ProviderHTTP):
    name: ProviderName = "gmail"
    origin = "https://gmail.googleapis.com"
    root = "/gmail/v1/users/me"

    def _get_message(self, identifier: str) -> GmailMessage:
        raw = self.request(
            "GET", self.root + "/messages/" + quote(identifier, safe=""), params={"format": "full"}
        )
        try:
            return GmailMessage.model_validate(raw)
        except ValidationError as error:
            raise ProviderError("Gmail devolvió un mensaje inválido.") from error

    def _normalize(self, item: GmailMessage) -> ProviderMessage:
        headers = {header.name.lower(): header.value for header in item.payload.headers}
        try:
            received = (
                datetime.fromtimestamp(int(item.internalDate) / 1000, UTC)
                .isoformat(timespec="seconds")
                .replace("+00:00", "Z")
            )
        except (ValueError, OverflowError, OSError) as error:
            raise ProviderError("Gmail devolvió una fecha inválida.") from error
        subject = plain_text(headers.get("subject", ""))[:500] or "(Sin asunto)"
        preview = plain_text(item.snippet)[:2000]
        return ProviderMessage(
            provider_id=item.id,
            subject=subject,
            sender=plain_text(headers.get("from", ""))[:500],
            preview=preview,
            body=decode_part(item.payload),
            received_at=received,
            category=category_for(subject, preview, important="IMPORTANT" in item.labelIds),
            unread="UNREAD" in item.labelIds,
            archived="INBOX" not in item.labelIds,
            web_url="https://mail.google.com/mail/u/0/#all/" + quote(item.threadId, safe=""),
            location={"label_ids": item.labelIds},
        )

    def _initial_cursor(self) -> GmailCursor:
        profile = self.request("GET", self.root + "/profile")
        try:
            return GmailCursor(history_id=required_string(profile.get("historyId")))
        except ValidationError as error:
            raise ProviderError("Gmail devolvió un cursor inválido.") from error

    def sync(self, cursor: str | None) -> SyncBatch:
        try:
            state = GmailCursor.model_validate_json(cursor) if cursor else self._initial_cursor()
        except ValidationError as error:
            raise ProviderError("El cursor guardado de Gmail es inválido.") from error
        messages: list[ProviderMessage] = []
        removed: list[str] = []
        snapshot: list[str] | None = None
        for _ in range(self.max_pages):
            params: dict[str, str | int] = {"maxResults": min(50, self.max_messages)}
            if state.page_token:
                params["pageToken"] = state.page_token
            if state.mode == "baseline":
                params["labelIds"] = "INBOX"
                data = self.request("GET", self.root + "/messages", params=params)
                values = data.get("messages", [])
                if not isinstance(values, list):
                    raise ProviderError("Gmail devolvió una lista inválida.")
                ids = [
                    required_string(value.get("id")) for value in values if isinstance(value, dict)
                ]
                if len(ids) != len(values):
                    raise ProviderError("Gmail devolvió una lista inválida.")
            else:
                params["startHistoryId"] = state.history_id
                try:
                    data = self.request("GET", self.root + "/history", params=params)
                except ProviderError as error:
                    if error.code != 404:
                        raise
                    # Expired history requires a full baseline before reconciliation.
                    return self.sync(None)
                history = data.get("history", [])
                if not isinstance(history, list):
                    raise ProviderError("Gmail devolvió un historial inválido.")
                ids = []
                for record in history:
                    if not isinstance(record, dict):
                        raise ProviderError("Gmail devolvió un historial inválido.")
                    for kind in (
                        "messagesAdded",
                        "messagesDeleted",
                        "labelsAdded",
                        "labelsRemoved",
                    ):
                        events = record.get(kind, [])
                        if not isinstance(events, list):
                            raise ProviderError("Gmail devolvió un historial inválido.")
                        for event in events:
                            if not isinstance(event, dict) or not isinstance(
                                event.get("message"), dict
                            ):
                                raise ProviderError("Gmail devolvió un historial inválido.")
                            ids.append(required_string(event["message"].get("id")))
                ids = list(dict.fromkeys(ids))
            if len(messages) + len(removed) + len(ids) > self.max_messages:
                raise ProviderError("La página de Gmail excede el límite de sincronización.")
            for identifier in ids:
                try:
                    message = self._normalize(self._get_message(identifier))
                except ProviderError as error:
                    if error.code != 404:
                        raise
                    removed.append(identifier)
                    continue
                messages.append(message)
                if state.mode == "baseline" and not message.archived:
                    state.seen_ids.append(identifier)
            if len(state.seen_ids) > 10_000:
                raise ProviderError("El buzón supera el límite inicial de 10000 mensajes.")
            next_page = data.get("nextPageToken")
            state.page_token = required_string(next_page) if next_page else None
            if not next_page:
                if state.mode == "baseline":
                    snapshot = list(dict.fromkeys(state.seen_ids))
                    state.seen_ids = []
                    state.mode = "history"
                else:
                    history_id = required_string(data.get("historyId"))
                    if not history_id.isdigit():
                        raise ProviderError("Gmail devolvió un cursor inválido.")
                    state.history_id = history_id
                break
            if len(messages) + len(removed) >= self.max_messages:
                break
        return SyncBatch(messages, state.model_dump_json(), removed, snapshot)

    def inspect(self, provider_id: str) -> dict[str, Any]:
        value = self.request(
            "GET",
            self.root + "/messages/" + quote(provider_id, safe=""),
            params={"format": "minimal"},
        )
        labels = value.get("labelIds")
        if not isinstance(labels, list) or not all(isinstance(label, str) for label in labels):
            raise ProviderError("Gmail devolvió etiquetas inválidas.")
        return {"label_ids": labels}

    def create_draft(self, provider_id: str, body: str) -> DraftResult:
        message = self._get_message(provider_id)
        headers = {item.name.lower(): item.value for item in message.payload.headers}
        raw_recipient = headers.get("reply-to") or headers.get("from", "")
        if "\n" in raw_recipient or "\r" in raw_recipient:
            raise ProviderError("El destinatario del borrador es inválido.")
        recipient = parseaddr(raw_recipient)[1]
        if not re.fullmatch(r"[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+", recipient):
            raise ProviderError("El destinatario del borrador es inválido.")
        draft = EmailMessage()
        draft["To"] = recipient
        subject = headers.get("subject", "(Sin asunto)").replace("\r", " ").replace("\n", " ")[:500]
        draft["Subject"] = subject if subject.lower().startswith("re:") else "Re: " + subject
        message_id = headers.get("message-id", "")
        if message_id and "\r" not in message_id and "\n" not in message_id:
            draft["In-Reply-To"] = message_id[:998]
            draft["References"] = message_id[:998]
        draft.set_content(body)
        encoded = base64.urlsafe_b64encode(draft.as_bytes()).decode()
        value = self.request(
            "POST",
            self.root + "/drafts",
            body={"message": {"raw": encoded, "threadId": message.threadId}},
        )
        try:
            identifier = required_string(value.get("id"))
        except ProviderError as error:
            raise ProviderError(
                "No se pudo confirmar el borrador de Gmail.", uncertain=True
            ) from error
        return DraftResult(
            id=identifier, provider=self.name, web_url="https://mail.google.com/mail/u/0/#drafts"
        )

    def _modify(
        self, provider_id: str, changes: dict[str, Any], expected_inbox: bool
    ) -> MutationResult:
        self.request(
            "POST", self.root + "/messages/" + quote(provider_id, safe="") + "/modify", body=changes
        )
        try:
            actual = self.inspect(provider_id)
            if ("INBOX" in actual["label_ids"]) != expected_inbox:
                raise ProviderError("Las etiquetas de Gmail no coinciden con el cambio.")
        except ProviderError as error:
            raise ProviderError(
                "El cambio de etiquetas requiere revisión manual.", uncertain=True
            ) from error
        return MutationResult(provider_id=provider_id, location=actual)

    def archive(self, provider_id: str, previous: dict[str, Any]) -> MutationResult:
        if "INBOX" not in previous.get("label_ids", []):
            raise ProviderError(
                "El correo ya no está en la bandeja de entrada. Sincronice primero.", code=409
            )
        return self._modify(provider_id, {"removeLabelIds": ["INBOX"]}, False)

    def restore(
        self, provider_id: str, previous: dict[str, Any], current: dict[str, Any]
    ) -> MutationResult:
        if "INBOX" not in previous.get("label_ids", []):
            raise ProviderError("No existe una etiqueta anterior para restaurar.", code=409)
        actual = self.inspect(provider_id)
        if "INBOX" in actual["label_ids"]:
            return MutationResult(provider_id=provider_id, location=actual)
        if any(label in actual["label_ids"] for label in ("TRASH", "SPAM")):
            raise ProviderError(
                "El correo cambió a spam o papelera. Revíselo antes de deshacer.", code=409
            )
        return self._modify(provider_id, {"addLabelIds": ["INBOX"]}, True)
