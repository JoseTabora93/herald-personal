"""Binary reads from the configured mail authority; never accept a caller URL."""

from typing import Annotated, Literal
from urllib.parse import quote, unquote

import httpx
from pydantic import Field, model_validator

from .errors import ServiceError
from .mail_workspace import MailWorkspace
from .mail_workspace_models import MailKey, ReadParams

AssetId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_+/=-]{1,2048}$")]
MAX_ASSET_BYTES = 20 * 1024 * 1024
RASTER = {"image/png", "image/jpeg", "image/gif", "image/webp"}


class MailAsset(ReadParams):
    kind: Literal["attachment", "signature"]
    clave: MailKey | None = None
    message_id: AssetId | None = None
    attachment_id: AssetId | None = None

    @model_validator(mode="after")
    def complete_reference(self) -> "MailAsset":
        refs = (self.clave, self.message_id, self.attachment_id)
        if self.kind == "attachment" and not all(refs):
            raise ValueError("Falta la referencia de correo.")
        if self.kind == "signature" and any(refs):
            raise ValueError("La firma no acepta referencias.")
        return self


def read_asset(workspace: MailWorkspace, asset: MailAsset) -> tuple[bytes, str, str]:
    if not workspace.configured:
        raise ServiceError(503, "El espacio de correo no está disponible.")
    token = workspace.token.read()
    if workspace.token_required and not token:
        raise ServiceError(503, "La credencial de correo no está disponible.")
    headers = {"Accept": "application/octet-stream"}
    if token:
        headers["Authorization"] = "Bearer " + token
    path = "/api/firma-imagen" if asset.kind == "signature" else "/api/mail-attachment"
    params = (
        None
        if asset.kind == "signature"
        else {
            "clave": asset.clave,
            "mensaje": asset.message_id,
            "adjunto": asset.attachment_id,
        }
    )
    maximum = 1_500_000 if asset.kind == "signature" else MAX_ASSET_BYTES
    try:
        with workspace.client.stream(
            "GET",
            str(workspace.base_url) + path,
            params=params,
            headers=headers,
            follow_redirects=False,
            timeout=60,
        ) as response:
            if response.status_code == 404:
                raise ServiceError(404, "No está disponible la imagen o el adjunto.")
            if response.status_code != 200:
                raise ServiceError(502, "El servicio de correo no confirmó el archivo.")
            if int(response.headers.get("content-length", "0")) > maximum:
                raise ServiceError(502, "El archivo supera el límite de descarga.")
            mime = response.headers.get("content-type", "application/octet-stream").split(";")[0]
            if asset.kind == "signature" and mime not in RASTER:
                raise ServiceError(502, "La firma no es una imagen compatible.")
            body = bytearray()
            for chunk in response.iter_bytes(chunk_size=65536):
                body.extend(chunk)
                if len(body) > maximum:
                    raise ServiceError(502, "El archivo supera el límite de descarga.")
            if not body:
                raise ServiceError(502, "El archivo está vacío.")
            name = unquote(
                response.headers.get(
                    "x-mail-filename", "firma" if asset.kind == "signature" else "adjunto"
                )
            )
            name = name.replace("\\", "/").split("/")[-1]
            name = (
                "".join(c for c in name if ord(c) >= 32 and c not in "\x7f\r\n")[:180] or "adjunto"
            )
            return bytes(body), mime, quote(name, safe="")
    except (httpx.HTTPError, ValueError, UnicodeError) as error:
        raise ServiceError(502, "No se pudo descargar el archivo de correo.") from error
