"""The one authenticated personal API shared by desktop and Hermes tools."""

import sqlite3
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import __version__
from .agents import AgentRun, AgentRuns
from .config import CredentialSource, Settings, TokenSource
from .database import Database
from .errors import ServiceError
from .mail import MailService
from .models import (
    TIMEZONE,
    CaptureInput,
    CategorizeInput,
    Checkin,
    CheckinInput,
    ConfirmInput,
    DraftInput,
    MailCategory,
    MailThread,
    MailThreadPage,
    ProviderName,
    SyncInput,
    Task,
    TaskCreate,
    TaskPatch,
    TaskStatus,
    utc_now,
)
from .providers.base import DraftResult, MailProvider, ProviderHTTP
from .providers.gmail import GmailProvider
from .providers.graph import GraphProvider
from .records import Records
from .security import RequestGuard

TASK_STATUS_LABELS: dict[TaskStatus, str] = {
    "inbox": "Por ordenar",
    "next": "Siguiente",
    "in_progress": "En curso",
    "waiting": "En espera",
    "done": "Completado",
    "cancelled": "Cancelado",
}


def default_providers(settings: Settings) -> dict[ProviderName, MailProvider]:
    microsoft: CredentialSource = TokenSource(
        settings.microsoft365_token, settings.microsoft365_token_file
    )
    if (
        settings.microsoft365_msal_cache
        and settings.microsoft365_client_id
        and settings.microsoft365_tenant_id
    ):
        from .oauth import MsalTokenSource

        microsoft = MsalTokenSource(
            settings.microsoft365_msal_cache,
            settings.microsoft365_client_id,
            settings.microsoft365_tenant_id,
            scopes=("Mail.ReadWrite",)
            if settings.mail_draft_enabled or settings.mail_archive_enabled
            else ("Mail.Read",),
        )
    return {
        "microsoft365": GraphProvider(
            microsoft, max_pages=settings.max_sync_pages, max_messages=settings.max_sync_messages
        ),
        "gmail": GmailProvider(
            TokenSource(settings.gmail_token, settings.gmail_token_file),
            max_pages=settings.max_sync_pages,
            max_messages=settings.max_sync_messages,
        ),
    }


def create_app(
    settings: Settings | None = None, *, providers: dict[ProviderName, MailProvider] | None = None
) -> FastAPI:
    configuration = settings or Settings.from_env()
    database = Database(configuration.data_dir)
    records = Records(database)
    agent_runs = AgentRuns(database)
    adapters = default_providers(configuration)
    defaults = list(adapters.values())
    if providers:
        adapters.update(providers)
    mail = MailService(database, records, adapters)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        for adapter in defaults:
            if isinstance(adapter, ProviderHTTP):
                adapter.close()

    app = FastAPI(
        title="Herald Personal",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.add_middleware(RequestGuard, settings=configuration)

    @app.exception_handler(ServiceError)
    async def service_error(_: Request, error: ServiceError) -> JSONResponse:
        return JSONResponse({"detail": error.detail}, status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            {"detail": "Solicitud inválida. Revise los campos y sus límites."}, status_code=422
        )

    @app.exception_handler(sqlite3.Error)
    async def database_error(_: Request, __: sqlite3.Error) -> JSONResponse:
        return JSONResponse(
            {"detail": "El almacenamiento no pudo completar la operación."}, status_code=503
        )

    @app.get("/healthz")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/status")
    def status() -> dict[str, Any]:
        states = mail.statuses()
        configured = any(provider.configured for provider in states)
        return {
            "version": __version__,
            "timezone": TIMEZONE,
            "providers": states,
            "capabilities": {
                "mail_read": configured,
                "mail_draft": configured and configuration.mail_draft_enabled,
                "mail_archive": configured and configuration.mail_archive_enabled,
                "agent_supervision": True,
            },
        }

    def overview_data() -> dict[str, Any]:
        now = utc_now()
        tasks = [task for task in records.tasks() if task.status not in {"done", "cancelled"}]
        return {
            "timezone": TIMEZONE,
            "as_of": now,
            "counts": {
                "open": len(tasks),
                "overdue": sum(bool(task.due_at and task.due_at < now) for task in tasks),
                "urgent_mail": mail.urgent_count(),
                "waiting_review": sum(task.status == "waiting" for task in tasks),
            },
            "priorities": tasks[:10],
            "recent_checkins": records.checkins()[:7],
            "providers": mail.statuses(),
        }

    @app.get("/v1/overview")
    def overview() -> dict[str, Any]:
        return overview_data()

    @app.get("/v1/agent-runs")
    def runs() -> dict[str, list[AgentRun]]:
        return {"items": agent_runs.snapshots()}

    @app.put("/v1/agent-runs/{run_id}")
    def put_run(run_id: str, payload: AgentRun) -> AgentRun:
        return agent_runs.save(run_id, payload)

    @app.get("/v1/tasks")
    def tasks(
        status: TaskStatus | None = None, q: Annotated[str, Query(max_length=500)] = ""
    ) -> dict[str, list[Task]]:
        return {"items": records.tasks(status, q)}

    @app.get("/v1/tasks/{identifier}")
    def task(identifier: str) -> Task:
        return records.get_task(identifier)

    @app.post("/v1/tasks", status_code=201)
    def create_task(payload: TaskCreate) -> Task:
        return records.create_task(payload)

    @app.patch("/v1/tasks/{identifier}")
    def patch_task(identifier: str, payload: TaskPatch) -> Task:
        return records.patch_task(identifier, payload)

    @app.get("/v1/tasks/{identifier}/events")
    def task_events(identifier: str) -> dict[str, list[dict[str, str]]]:
        return {"items": records.task_events(identifier)}

    @app.get("/v1/mail/threads")
    def threads(
        q: Annotated[str, Query(max_length=500)] = "",
        category: MailCategory | None = None,
        limit: Annotated[int, Query(ge=1, le=50)] = 50,
        offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
    ) -> MailThreadPage:
        return mail.threads(q, category, limit=limit, offset=offset)

    @app.post("/v1/mail/sync")
    def sync_mail(payload: SyncInput) -> dict[str, str | int]:
        return {"count": mail.sync(payload.provider), "provider": payload.provider}

    @app.patch("/v1/mail/threads/{identifier}")
    def categorize(identifier: str, payload: CategorizeInput) -> MailThread:
        return mail.categorize(identifier, payload.category)

    @app.post("/v1/mail/threads/{identifier}/task")
    def capture(identifier: str, payload: CaptureInput) -> Task:
        return mail.capture(identifier, payload)

    @app.post("/v1/mail/threads/{identifier}/draft")
    def draft(identifier: str, payload: DraftInput) -> DraftResult:
        if not configuration.mail_draft_enabled:
            raise ServiceError(403, "El operador no habilitó la creación de borradores.")
        return mail.draft(identifier, payload.body)

    @app.post("/v1/mail/threads/{identifier}/archive")
    def archive(identifier: str, payload: ConfirmInput) -> dict[str, str | bool]:
        if not configuration.mail_archive_enabled:
            raise ServiceError(403, "El operador no habilitó el archivo de correos.")
        return mail.archive(identifier)

    @app.post("/v1/mail/actions/{action_id}/undo")
    def undo(action_id: str, payload: ConfirmInput) -> dict[str, bool]:
        if not configuration.mail_archive_enabled:
            raise ServiceError(403, "El operador no habilitó el archivo de correos.")
        return mail.undo(action_id)

    @app.get("/v1/checkins")
    def checkins() -> dict[str, list[Checkin]]:
        return {"items": records.checkins()}

    @app.put("/v1/checkins/{local_date}")
    def checkin(local_date: str, payload: CheckinInput) -> Checkin:
        return records.save_checkin(local_date, payload)

    @app.get("/v1/brief")
    def brief(kind: Literal["morning", "evening"] = "morning") -> dict[str, Any]:
        data = overview_data()
        tasks: list[Task] = data["priorities"]
        checkins: list[Checkin] = data["recent_checkins"]
        heading = (
            "Buenos días. Tus compromisos de hoy:"
            if kind == "morning"
            else "Cierre del día. Compromisos por revisar:"
        )
        lines = [
            heading,
            f"Abiertos: {data['counts']['open']}. Vencidos: {data['counts']['overdue']}.",
        ]
        lines += [f"- {task.title} ({TASK_STATUS_LABELS[task.status]})" for task in tasks]
        if not tasks:
            lines.append("No hay compromisos abiertos registrados.")
        if kind == "evening":
            lines.append("¿Qué completaste, qué queda pendiente y qué priorizarás mañana?")
        source_ids = [task.id for task in tasks]
        if checkins:
            lines.append(f"Último diario ({checkins[0].date}): {checkins[0].tomorrow}")
            source_ids.append(checkins[0].id)
        return {"text": "\n".join(lines), "generated_at": data["as_of"], "source_ids": source_ids}

    return app
