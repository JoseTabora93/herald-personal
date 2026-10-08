"""Bounded provider HTTP and typed, credential-free results."""

import json
import time
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any, Literal, Protocol
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, Field

from ..config import CredentialSource, TokenSource
from ..models import MailCategory, ProviderName


class ProviderError(Exception):
    def __init__(self, message: str, *, uncertain: bool = False, code: int | None = None):
        super().__init__(message)
        self.uncertain = uncertain
        self.code = code


class ProviderMessage(BaseModel):
    provider_id: str
    subject: str
    sender: str
    preview: str
    body: str
    received_at: str
    category: MailCategory = "reference"
    unread: bool
    web_url: str | None = None
    archived: bool = False
    location: dict[str, Any] = Field(default_factory=dict)


@dataclass
class SyncBatch:
    messages: list[ProviderMessage]
    cursor: str
    removed_ids: list[str] = field(default_factory=list)
    snapshot_ids: list[str] | None = None


class DraftResult(BaseModel):
    id: str
    web_url: str | None
    provider: ProviderName


class MutationResult(BaseModel):
    provider_id: str
    location: dict[str, Any]


class MailProvider(Protocol):
    name: ProviderName

    @property
    def configured(self) -> bool: ...
    def sync(self, cursor: str | None) -> SyncBatch: ...
    def inspect(self, provider_id: str) -> dict[str, Any]: ...
    def create_draft(self, provider_id: str, body: str) -> DraftResult: ...
    def archive(self, provider_id: str, previous: dict[str, Any]) -> MutationResult: ...
    def restore(
        self, provider_id: str, previous: dict[str, Any], current: dict[str, Any]
    ) -> MutationResult: ...


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.blocked_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "iframe", "object"}:
            self.blocked_depth += 1
        elif tag in {"br", "p", "div", "li", "tr"} and not self.blocked_depth:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "iframe", "object"}:
            self.blocked_depth = max(0, self.blocked_depth - 1)

    def handle_data(self, data: str) -> None:
        if not self.blocked_depth:
            self.parts.append(data)


def plain_text(content: str, is_html: bool = False) -> str:
    content = content[:200_000]
    if is_html:
        parser = TextExtractor()
        parser.feed(content)
        content = "".join(parser.parts)
    return "".join(c for c in content if c in "\n\t" or ord(c) >= 32).strip()[:50_000]


def category_for(subject: str, preview: str, *, important: bool = False) -> MailCategory:
    text = (subject + " " + preview).lower()
    if important or any(word in text for word in ("urgente", "urgent", "vencido")):
        return "urgent"
    if any(word in text for word in ("unsubscribe", "newsletter", "desuscrib", "boletín")):
        return "newsletter"
    if any(
        word in text for word in ("confirmar", "revisar", "approve", "aprobar", "action required")
    ):
        return "action"
    if any(word in text for word in ("esperando", "pending", "a la espera")):
        return "waiting"
    return "reference"


def safe_web_url(value: object, hosts: set[str]) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 4096:
        return None
    try:
        parsed = urlparse(value)
        valid = (
            parsed.scheme == "https"
            and parsed.hostname in hosts
            and not parsed.username
            and not parsed.password
            and parsed.port in {None, 443}
        )
    except ValueError:
        return None
    if not valid:
        return None
    return value


def required_string(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 16_384:
        raise ProviderError("El proveedor devolvió una respuesta inválida.")
    return value


class ProviderHTTP:
    origin: str

    def __init__(
        self,
        token: str | CredentialSource | None,
        *,
        client: httpx.Client | None = None,
        max_pages: int = 3,
        max_messages: int = 150,
        retry_delay: float = 0.2,
    ):
        self.token: CredentialSource = (
            TokenSource(token) if isinstance(token, str) or token is None else token
        )
        self.client = client or httpx.Client(timeout=20, follow_redirects=False, trust_env=False)
        self.owns_client = client is None
        self.max_pages = max(1, min(max_pages, 10))
        self.max_messages = max(1, min(max_messages, 1000))
        self.retry_delay = max(0, min(retry_delay, 1))

    @property
    def configured(self) -> bool:
        return self.token.configured

    def close(self) -> None:
        if self.owns_client:
            self.client.close()

    def request(
        self,
        method: Literal["GET", "POST"],
        path: str,
        *,
        params: dict[str, str | int] | None = None,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        token = self.token.read()
        if token is None:
            raise ProviderError("Faltan credenciales válidas del proveedor.", code=503)
        url = path if path.startswith("https://") else self.origin + path
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.netloc != urlparse(self.origin).netloc:
            raise ProviderError("El proveedor devolvió una dirección no permitida.")
        for attempt in range(3 if method == "GET" else 1):
            try:
                with self.client.stream(
                    method,
                    url,
                    params=params,
                    json=body,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Accept": "application/json",
                        **(headers or {}),
                    },
                    follow_redirects=False,
                    timeout=20,
                ) as response:
                    code = response.status_code
                    if method == "GET" and code in {429, 500, 502, 503, 504} and attempt < 2:
                        retry_after = response.headers.get("Retry-After", "0")
                        if retry_after.isdigit() and int(retry_after) > 2:
                            raise ProviderError(
                                "El proveedor limitó las solicitudes. Reintente más tarde.",
                                code=code,
                            )
                        time.sleep(min(1, self.retry_delay * (2**attempt)))
                        continue
                    if code < 200 or code >= 300:
                        message = {
                            401: (
                                "La credencial del proveedor expiró o fue rechazada. "
                                "Renueve el acceso."
                            ),
                            403: "El proveedor no autorizó esta operación. Revise los permisos.",
                            404: "El recurso del proveedor ya no está disponible.",
                            429: "El proveedor limitó las solicitudes. Reintente más tarde.",
                        }.get(code, "El proveedor no pudo completar la operación.")
                        raise ProviderError(
                            message, uncertain=method != "GET" and code >= 500, code=code
                        )
                    chunks, length = [], 0
                    for chunk in response.iter_bytes():
                        length += len(chunk)
                        if length > 5_000_000:
                            raise ProviderError(
                                "La respuesta del proveedor excede el límite.",
                                uncertain=method != "GET",
                            )
                        chunks.append(chunk)
                    value = json.loads(b"".join(chunks))
                    if not isinstance(value, dict):
                        raise ValueError
                    return value
            except httpx.TransportError as error:
                if method == "GET" and attempt < 2:
                    time.sleep(self.retry_delay * (2**attempt))
                    continue
                raise ProviderError(
                    "No se pudo confirmar la respuesta del proveedor.", uncertain=method != "GET"
                ) from error
            except (ValueError, UnicodeError) as error:
                raise ProviderError(
                    "El proveedor devolvió una respuesta inválida.", uncertain=method != "GET"
                ) from error
        raise ProviderError("El proveedor no respondió después de los reintentos permitidos.")
