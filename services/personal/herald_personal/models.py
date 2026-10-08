"""Validated HTTP contracts. Email text never supplies control parameters."""

import re
from datetime import UTC, date, datetime, time
from typing import Annotated, Literal, Self
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

TIMEZONE = "America/Tegucigalpa"
TaskStatus = Literal["inbox", "next", "in_progress", "waiting", "done", "cancelled"]
Priority = Literal["low", "normal", "high"]
SourceType = Literal["manual", "mail", "whatsapp", "agent"]
ProviderName = Literal["microsoft365", "gmail"]
MailCategory = Literal["urgent", "action", "waiting", "reference", "newsletter"]
Title = Annotated[str, Field(min_length=1, max_length=500)]
ShortText = Annotated[str, Field(max_length=500)]
LongText = Annotated[str, Field(max_length=50_000)]
Identifier = Annotated[str, Field(min_length=1, max_length=200)]


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def utc_timestamp(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("La fecha y hora debe incluir zona horaria.")
    return parsed.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def due_timestamp(value: str | None) -> str | None:
    if value is None:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        parsed = datetime.combine(date.fromisoformat(value), time(23, 59, 59), ZoneInfo(TIMEZONE))
        return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return utc_timestamp(value)


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class TaskCreate(InputModel):
    title: Title
    description: LongText | None = None
    status: TaskStatus = "inbox"
    priority: Priority = "normal"
    due_at: str | None = None
    source_type: SourceType = "manual"
    source_id: Identifier | None = None
    project: ShortText | None = None
    idempotency_key: Identifier | None = None

    _due = field_validator("due_at")(due_timestamp)

    @model_validator(mode="after")
    def source_requires_id(self) -> Self:
        if self.source_type != "manual" and not self.source_id:
            raise ValueError("La fuente requiere un identificador.")
        return self


class TaskPatch(InputModel):
    title: Title | None = None
    description: LongText | None = None
    status: TaskStatus | None = None
    priority: Priority | None = None
    due_at: str | None = None
    project: ShortText | None = None
    expected_revision: Annotated[int, Field(strict=True, ge=1)]

    _due = field_validator("due_at")(due_timestamp)

    @model_validator(mode="after")
    def non_nullable_fields(self) -> Self:
        for field in ("title", "status", "priority"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} no acepta null.")
        if self.model_fields_set == {"expected_revision"}:
            raise ValueError("Incluya al menos un cambio.")
        return self


class Task(BaseModel):
    id: str
    title: str
    description: str | None
    status: TaskStatus
    priority: Priority
    due_at: str | None
    source_type: SourceType
    source_id: str | None
    project: str | None
    agent_task_id: str | None
    created_at: str
    updated_at: str
    revision: int


class CheckinInput(InputModel):
    accomplished: LongText
    pending: LongText
    tomorrow: LongText


class Checkin(CheckinInput):
    id: str
    date: str
    created_at: str
    updated_at: str


class MailThread(BaseModel):
    id: str
    provider: ProviderName
    subject: str
    sender: str
    preview: str
    body: str
    received_at: str
    category: MailCategory
    unread: bool
    web_url: str | None
    task_id: str | None
    archived: bool


class ProviderStatus(BaseModel):
    provider: ProviderName
    configured: bool
    connected: bool
    last_sync_at: str | None
    error: str | None


class MailThreadPage(BaseModel):
    items: list[MailThread]
    providers: list[ProviderStatus]
    total: int
    offset: int
    next_offset: int | None


class SyncInput(InputModel):
    provider: ProviderName


class CategorizeInput(InputModel):
    category: MailCategory


class CaptureInput(InputModel):
    title: Title | None = None
    due_at: str | None = None
    priority: Priority = "normal"

    _due = field_validator("due_at")(due_timestamp)


class DraftInput(InputModel):
    body: Annotated[str, Field(min_length=1, max_length=50_000)]


class ConfirmInput(InputModel):
    confirmed: StrictBool

    @field_validator("confirmed")
    @classmethod
    def explicit_true(cls, value: bool) -> bool:
        if not value:
            raise ValueError("Se requiere confirmación explícita.")
        return value
