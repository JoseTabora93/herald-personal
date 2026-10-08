"""Microsoft Graph inbox delta, reply drafts and verified folder moves."""

from typing import Any
from urllib.parse import quote, urlparse

from pydantic import BaseModel, Field, ValidationError

from ..models import ProviderName, utc_timestamp
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
    safe_web_url,
)


class GraphAddress(BaseModel):
    address: str = ""
    name: str = ""


class GraphSender(BaseModel):
    emailAddress: GraphAddress = Field(default_factory=GraphAddress)


class GraphBody(BaseModel):
    content: str = ""
    contentType: str = "text"


class GraphMessage(BaseModel):
    id: str = Field(min_length=1, max_length=16_384)
    subject: str = ""
    sender: GraphSender = Field(default_factory=GraphSender, alias="from")
    bodyPreview: str = ""
    body: GraphBody = Field(default_factory=GraphBody)
    receivedDateTime: str
    isRead: bool
    parentFolderId: str
    webLink: str | None = None
    importance: str = "normal"


class GraphProvider(ProviderHTTP):
    name: ProviderName = "microsoft365"
    origin = "https://graph.microsoft.com"
    inbox_path = "/v1.0/me/mailFolders/inbox/messages/delta"
    preference = 'IdType="ImmutableId", outlook.body-content-type="text", odata.maxpagesize=50'

    def get(self, path: str, params: dict[str, str | int] | None = None) -> dict[str, Any]:
        return self.request("GET", path, params=params, headers={"Prefer": self.preference})

    def _cursor(self, value: object) -> str:
        url = required_string(value)
        parsed = urlparse(url)
        allowed_paths = {self.inbox_path, "/v1.0/me/mailFolders('inbox')/messages/delta"}
        if (
            parsed.scheme != "https"
            or parsed.netloc != "graph.microsoft.com"
            or parsed.path not in allowed_paths
            or parsed.fragment
        ):
            raise ProviderError("El cursor de Microsoft 365 no pertenece al buzón permitido.")
        return url

    def sync(self, cursor: str | None) -> SyncBatch:
        path = self._cursor(cursor) if cursor else self.inbox_path
        messages: list[ProviderMessage] = []
        removed: list[str] = []
        for _ in range(self.max_pages):
            data = self.get(path)
            values = data.get("value")
            if not isinstance(values, list):
                raise ProviderError("Microsoft 365 devolvió una colección inválida.")
            if len(messages) + len(removed) + len(values) > self.max_messages:
                raise ProviderError(
                    "La página de Microsoft 365 excede el límite de sincronización."
                )
            for raw in values:
                if not isinstance(raw, dict):
                    raise ProviderError("Microsoft 365 devolvió un mensaje inválido.")
                if "@removed" in raw:
                    removed.append(required_string(raw.get("id")))
                    continue
                try:
                    item = GraphMessage.model_validate(raw)
                    received = utc_timestamp(item.receivedDateTime)
                except (ValidationError, ValueError) as error:
                    raise ProviderError("Microsoft 365 devolvió un mensaje inválido.") from error
                subject = plain_text(item.subject)[:500] or "(Sin asunto)"
                preview = plain_text(item.bodyPreview)[:2000]
                messages.append(
                    ProviderMessage(
                        provider_id=item.id,
                        subject=subject,
                        sender=plain_text(item.sender.emailAddress.address)[:500],
                        preview=preview,
                        body=plain_text(item.body.content, item.body.contentType.lower() == "html"),
                        received_at=received,
                        unread=not item.isRead,
                        category=category_for(
                            subject, preview, important=item.importance == "high"
                        ),
                        web_url=safe_web_url(
                            item.webLink,
                            {"outlook.office.com", "outlook.office365.com", "outlook.live.com"},
                        ),
                        location={"folder_id": item.parentFolderId},
                    )
                )
            next_link = data.get("@odata.nextLink")
            path = self._cursor(next_link or data.get("@odata.deltaLink"))
            if not next_link or len(messages) + len(removed) >= self.max_messages:
                break
        return SyncBatch(messages, path, removed)

    @staticmethod
    def _message_path(provider_id: str) -> str:
        return "/v1.0/me/messages/" + quote(provider_id, safe="")

    def inspect(self, provider_id: str) -> dict[str, Any]:
        value = self.get(self._message_path(provider_id), {"$select": "id,parentFolderId"})
        return {"folder_id": required_string(value.get("parentFolderId"))}

    def create_draft(self, provider_id: str, body: str) -> DraftResult:
        value = self.request(
            "POST",
            self._message_path(provider_id) + "/createReply",
            body={"message": {"body": {"contentType": "Text", "content": body}}},
            headers={"Prefer": self.preference},
        )
        try:
            identifier = required_string(value.get("id"))
            if value.get("isDraft") is not True:
                raise ProviderError("El proveedor no confirmó el tipo de borrador.")
        except ProviderError as error:
            raise ProviderError(
                "No se pudo verificar el borrador creado.", uncertain=True
            ) from error
        return DraftResult(
            id=identifier,
            provider=self.name,
            web_url=safe_web_url(
                value.get("webLink"),
                {"outlook.office.com", "outlook.office365.com", "outlook.live.com"},
            ),
        )

    def _move(self, provider_id: str, destination: str) -> MutationResult:
        response = self.request(
            "POST",
            self._message_path(provider_id) + "/move",
            body={"destinationId": destination},
            headers={"Prefer": self.preference},
        )
        try:
            identifier = required_string(response.get("id"))
            actual = self.inspect(identifier)
            if actual["folder_id"] != destination:
                raise ProviderError("No se pudo verificar la carpeta de destino.")
        except ProviderError as error:
            raise ProviderError(
                "El movimiento requiere revisión manual del buzón.", uncertain=True
            ) from error
        return MutationResult(provider_id=identifier, location=actual)

    def archive(self, provider_id: str, previous: dict[str, Any]) -> MutationResult:
        archive_folder = self.get("/v1.0/me/mailFolders/archive", {"$select": "id"})
        destination = required_string(archive_folder.get("id"))
        if previous.get("folder_id") == destination:
            raise ProviderError(
                "El correo ya está en archivo. Sincronice el buzón primero.", code=409
            )
        return self._move(provider_id, destination)

    def restore(
        self, provider_id: str, previous: dict[str, Any], current: dict[str, Any]
    ) -> MutationResult:
        if self.inspect(provider_id) != current:
            raise ProviderError(
                "El correo cambió de carpeta. Revise el buzón antes de deshacer.", code=409
            )
        return self._move(provider_id, required_string(previous.get("folder_id")))
