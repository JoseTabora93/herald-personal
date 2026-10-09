"""Local draft/classification contracts. Never proxy uiOnly or provider writes."""

from typing import Annotated, Literal

from pydantic import Field, model_validator

from .mail_workspace_models import Category, MailKey, Priority, ReadParams, State

LocalId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")]


class ItemEdit(ReadParams):
    id: MailKey
    estado: State | None = None
    categoria: Category | None = None
    prioridad: Priority | None = None


class ComposeId(ReadParams):
    id: LocalId


class ComposeOpen(ReadParams):
    modo: Literal["nuevo", "responder", "responder_todos", "reenviar"]
    clave: MailKey | None = None
    usarSugerido: bool = False
    reemplazar: bool = False

    @model_validator(mode="after")
    def reply_key(self) -> "ComposeOpen":
        if self.modo != "nuevo" and self.clave is None:
            raise ValueError("La respuesta requiere un hilo.")
        return self


class Recipient(ReadParams):
    nombre: Annotated[str, Field(max_length=200)] = ""
    direccion: Annotated[str, Field(min_length=1, max_length=254)]


class ComposeSave(ComposeId):
    asunto: Annotated[str, Field(max_length=500)] | None = None
    para: Annotated[list[Recipient], Field(max_length=100)] | None = None
    cc: Annotated[list[Recipient], Field(max_length=100)] | None = None
    cco: Annotated[list[Recipient], Field(max_length=100)] | None = None
    cuerpoMd: Annotated[str, Field(max_length=50_000)] | None = None
    incluirFirma: bool | None = None


class DraftReply(ReadParams):
    id: MailKey
    instrucciones: Annotated[str, Field(max_length=600)] = ""
    forzar: bool = False


class DraftAdjust(ReadParams):
    id: MailKey
    instruccion: Annotated[str, Field(max_length=600)] = ""
    modo: Literal["ajustar", "regenerar"] = "ajustar"
    composeId: LocalId | None = None


class DraftVersion(ReadParams):
    id: MailKey
    hacia: Literal["anterior", "siguiente"]
    composeId: LocalId | None = None


LOCAL_ACTIONS: dict[str, type[ReadParams]] = {
    "mail-update-item": ItemEdit,
    "mail-compose-get": ComposeId,
    "mail-compose-open": ComposeOpen,
    "mail-compose-save": ComposeSave,
    "mail-draft-reply": DraftReply,
    "mail-draft-adjust": DraftAdjust,
    "mail-draft-version": DraftVersion,
}
