"""Explicit read-action contracts for the existing Ingelmec Mail workspace."""

from datetime import date
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .models import CaptureInput, utc_timestamp

MailKey = Annotated[str, Field(pattern=r"^MAIL-[1-9][0-9]{0,9}$")]
Period = Annotated[str, Field(pattern=r"^(ventana|todo|[1-9][0-9]{0,3})$")]
State = Literal[
    "por_clasificar", "debo_respuesta", "para_enterarme", "esperando_respuesta", "agendado", "hecho"
]
Category = Literal["Clientes", "Proveedores", "Licitaciones", "Interno", "Notificaciones", "Ruido"]
Priority = Literal["alta", "media", "baja"]
Recipient = Literal["para_jose", "para_otro", "para_grupo", "indeterminado"]
ShortText = Annotated[str, Field(max_length=500)]


class ReadParams(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CountsParams(ReadParams):
    atrasadosDias: Annotated[int, Field(ge=0, le=3650)] = 2
    periodo: Period = "ventana"


class ListParams(ReadParams):
    estado: Annotated[list[State], Field(min_length=1, max_length=6)] | State | None = None
    categoria: Annotated[list[Category], Field(min_length=1, max_length=6)] | Category | None = None
    prioridad: Annotated[list[Priority], Field(min_length=1, max_length=3)] | Priority | None = None
    noLeido: bool | None = None
    carpeta: Annotated[list[ShortText], Field(min_length=1, max_length=20)] | ShortText | None = (
        None
    )
    jevDuda: bool | None = None
    revisadoAgente: bool | None = None
    sinClasificar: bool | None = None
    paraMi: bool | None = None
    destinatario: (
        Annotated[list[Recipient], Field(min_length=1, max_length=4)] | Recipient | None
    ) = None
    texto: ShortText | None = None
    atrasadosDias: Annotated[int, Field(ge=0, le=3650)] | None = None
    antiguosDias: Annotated[int, Field(ge=0, le=3650)] | None = None
    periodo: Period = "ventana"
    orden: Literal["recientes", "antiguos", "prioridad", "noleidos"] = "recientes"
    ordenarPor: (
        Literal[
            "fecha", "clave", "asunto", "remitente", "carpeta", "categoria", "prioridad", "estado"
        ]
        | None
    ) = None
    direccion: Literal["asc", "desc"] | None = None
    limite: Annotated[int, Field(ge=1, le=100)] = 25
    desplazamiento: Annotated[int, Field(ge=0, le=100_000)] = 0


class ItemParams(ReadParams):
    id: MailKey
    formato: Literal["texto"] = "texto"
    maxMensajes: Annotated[int, Field(ge=1, le=25)] = 10
    maxCaracteresTexto: Annotated[int, Field(ge=200, le=50_000)] = 8000
    adjuntos: bool = False


class DraftParams(ReadParams):
    id: MailKey


class LearningParams(ReadParams):
    estado: Literal["propuesto", "activo", "descartado", "observacion", "todos"] = "todos"


class CleanupParams(ReadParams):
    limite: Annotated[int, Field(ge=1, le=100)] = 50
    desplazamiento: Annotated[int, Field(ge=0, le=100_000)] = 0
    carpeta: ShortText | None = None


class MetricsParams(ReadParams):
    desde: Annotated[str, Field(max_length=40)] | None = None
    hasta: Annotated[str, Field(max_length=40)] | None = None
    agrupar: Literal["dia", "semana"] = "dia"
    top: Annotated[int, Field(ge=1, le=50)] = 10

    @field_validator("desde", "hasta")
    @classmethod
    def valid_date(cls, value: str | None) -> str | None:
        if value is not None:
            if len(value) == 10:
                date.fromisoformat(value)
            else:
                utc_timestamp(value)
        return value


READ_ACTIONS: dict[str, type[ReadParams]] = {
    "mail-counts": CountsParams,
    "mail-list-items": ListParams,
    "mail-get-item": ItemParams,
    "mail-draft-get": DraftParams,
    "mail-carpetas": ReadParams,
    "mail-aprendizajes-listar": LearningParams,
    "mail-limpieza-propuestas": CleanupParams,
    "mail-metricas": MetricsParams,
    "mail-connection-status": ReadParams,
}


class WorkspaceQuery(ReadParams):
    action: Annotated[str, Field(min_length=1, max_length=80)]
    params: dict[str, Any] = Field(default_factory=dict)


class WorkspaceCapture(CaptureInput):
    clave: MailKey
