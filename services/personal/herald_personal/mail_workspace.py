"""Bounded read bridge; the original app retains mail state, models and human-only writes."""

import ipaddress
import json
from typing import Any
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError

from .config import Settings, TokenSource
from .errors import ServiceError
from .mail_local_models import LOCAL_ACTIONS
from .mail_workspace_models import READ_ACTIONS, WorkspaceCapture
from .models import Task, TaskCreate
from .records import Records

MAX_RESPONSE_BYTES = 1024 * 1024


def aggregate_count(snapshot: dict[str, Any], group: str, key: str) -> int | None:
    """A missing or malformed aggregate is unknown, never an invented zero."""
    counts = snapshot.get("counts")
    values = counts.get(group) if isinstance(counts, dict) else None
    value = values.get(key) if isinstance(values, dict) else None
    return value if type(value) is int and value >= 0 else None


def safe_origin(value: str | None) -> str | None:
    if not value or len(value) > 512 or any(not 33 <= ord(char) <= 126 for char in value):
        return None
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
            or (parsed.port is not None and not 1 <= parsed.port <= 65535)
        ):
            return None
        if (
            parsed.scheme == "http"
            and parsed.hostname != "localhost"
            and not ipaddress.ip_address(parsed.hostname).is_loopback
        ):
            return None
        return f"{parsed.scheme}://{parsed.netloc.lower()}"
    except ValueError:
        return None


class MailWorkspace:
    def __init__(self, settings: Settings, records: Records, *, client: httpx.Client | None = None):
        self.base_url = safe_origin(settings.mail_workspace_url)
        self.requested_url = settings.mail_workspace_url is not None
        self.token = TokenSource(path=settings.mail_workspace_token_file)
        self.token_required = settings.mail_workspace_token_file is not None
        self.records = records
        self.owns_client = client is None
        self.client = client or httpx.Client(
            timeout=httpx.Timeout(15, connect=2, write=5, pool=2),
            follow_redirects=False,
            trust_env=False,
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
        )

    def close(self) -> None:
        if self.owns_client:
            self.client.close()

    @property
    def configured(self) -> bool:
        return self.base_url is not None and (not self.token_required or self.token.configured)

    def status(self) -> dict[str, Any]:
        status: dict[str, Any] = {
            "configured": self.configured,
            "reachable": False,
            "base_url": self.base_url,
            "error": None,
            "counts": None,
        }
        if not self.configured:
            status["error"] = (
                "Revise la dirección y la credencial privada del espacio de correo."
                if self.requested_url
                else "Configure el espacio de correo original para conectarlo."
            )
            return status
        try:
            counts = self.query("mail-counts", {"periodo": "ventana"})
            if type(counts.get("total")) is not int or counts["total"] < 0:
                raise ServiceError(502, "El espacio de correo devolvió conteos inválidos.")
            status.update(reachable=True, counts=counts)
        except ServiceError as error:
            status["error"] = error.detail
        return status

    def query(self, action: str, params: dict[str, Any]) -> dict[str, Any]:
        schema = READ_ACTIONS.get(action)
        if schema is None:
            raise ServiceError(422, "Esta acción no está disponible en el puente de lectura.")
        try:
            validated = schema.model_validate(params).model_dump(exclude_none=True)
        except ValidationError as error:
            raise ServiceError(422, "Parámetros de correo inválidos.") from error
        return self._request(action, validated, method="GET")

    def local(self, action: str, params: dict[str, Any]) -> dict[str, Any]:
        schema = LOCAL_ACTIONS.get(action)
        if schema is None:
            raise ServiceError(422, "Esta operación requiere la interfaz original de correo.")
        try:
            validated = schema.model_validate(params).model_dump(exclude_none=True)
        except ValidationError as error:
            raise ServiceError(422, "Parámetros de correo inválidos.") from error
        return self._request(
            action, validated, method="GET" if action == "mail-compose-get" else "POST"
        )

    def _request(self, action: str, validated: dict[str, Any], *, method: str) -> dict[str, Any]:
        if self.base_url is None:
            raise ServiceError(503, "El espacio de correo original no está configurado.")
        token = self.token.read()
        if self.token_required and token is None:
            raise ServiceError(
                503, "La credencial privada del espacio de correo no está disponible."
            )
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        arguments = {
            name: ",".join(value)
            if isinstance(value, list)
            else str(value).lower()
            if isinstance(value, bool)
            else str(value)
            for name, value in (validated.items() if method == "GET" else [])
        }
        try:
            with self.client.stream(
                method,
                self.base_url + "/_agent-native/actions/" + action,
                params=arguments if method == "GET" else None,
                json=validated if method == "POST" else None,
                headers=headers,
                follow_redirects=False,
                timeout=httpx.Timeout(
                    120 if action in {"mail-draft-reply", "mail-draft-adjust"} else 15,
                    connect=2,
                    write=5,
                    pool=2,
                ),
            ) as response:
                if response.status_code == 404:
                    raise ServiceError(404, "No se encontró el recurso en el espacio de correo.")
                if response.status_code != 200:
                    raise ServiceError(
                        502, "El espacio de correo no confirmó la consulta autorizada."
                    )
                body = bytearray()
                for chunk in response.iter_bytes(chunk_size=65_536):
                    body.extend(chunk)
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise ServiceError(
                            502, "La respuesta supera el límite; reduzca la consulta."
                        )
                decoded = json.loads(body)
                if not isinstance(decoded, dict):
                    raise ValueError("Expected an object")
                encoded = json.dumps(
                    decoded, ensure_ascii=False, allow_nan=False, separators=(",", ":")
                ).encode("utf-8")
                if len(encoded) > MAX_RESPONSE_BYTES:
                    raise ServiceError(502, "La respuesta supera el límite; reduzca la consulta.")
                return decoded
        except (httpx.HTTPError, httpx.InvalidURL) as error:
            raise ServiceError(
                502, "No se pudo consultar el espacio de correo original."
            ) from error
        except (ValueError, UnicodeError, RecursionError) as error:
            raise ServiceError(
                502, "El espacio de correo devolvió una respuesta inválida."
            ) from error

    def capture(self, payload: WorkspaceCapture) -> Task:
        source = self.query(
            "mail-get-item",
            {
                "id": payload.clave,
                "formato": "texto",
                "maxMensajes": 1,
                "maxCaracteresTexto": 200,
                "adjuntos": False,
            },
        )
        item = source.get("item")
        if (
            not isinstance(item, dict)
            or item.get("clave") != payload.clave
            or not isinstance(item.get("asunto"), str)
            or not item["asunto"].strip()
        ):
            raise ServiceError(502, "El espacio de correo no confirmó el ítem solicitado.")
        description = f"Ingelmec Mail · {payload.clave}\n{self.base_url}/correo/{payload.clave}"
        return self.records.create_task(
            TaskCreate(
                title=payload.title or item["asunto"][:500],
                description=description,
                source_type="mail",
                source_id="ingelmec-mail:" + payload.clave,
                priority=payload.priority,
                due_at=payload.due_at,
            ),
            verified_mail_source="ingelmec-mail:" + payload.clave,
        )
