"""The one authenticated personal API shared by desktop and Hermes tools."""

import asyncio
import sqlite3
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from typing import Annotated, Any, Literal

import httpx
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from . import __version__
from .agents import AgentRun, AgentRuns
from .config import CredentialSource, Settings, TokenSource
from .database import Database
from .errors import ServiceError
from .live_observer import LiveObserver
from .mail import MailService
from .mail_assets import MailAsset, read_asset
from .mail_workspace import MailWorkspace, aggregate_count
from .mail_workspace_models import WorkspaceCapture, WorkspaceQuery
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
from .planning import Planning
from .planning_routes import attach_planning_routes
from .projects import Projects, attach_project_routes
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
    settings: Settings | None = None,
    *,
    providers: dict[ProviderName, MailProvider] | None = None,
    mail_workspace_client: httpx.Client | None = None,
) -> FastAPI:
    configuration = settings or Settings.from_env()
    database = Database(configuration.data_dir)
    records = Records(database)
    agent_runs = AgentRuns(database)
    workspace_selected = configuration.mail_workspace_url is not None
    adapters = {} if workspace_selected else default_providers(configuration)
    defaults = list(adapters.values())
    if providers and not workspace_selected:
        adapters.update(providers)
    mail = MailService(database, records, adapters)
    mail_workspace = MailWorkspace(configuration, records, client=mail_workspace_client)

    live_planning = Planning(database, records, mail_workspace.status)
    monitor = LiveObserver(configuration.observer_config_file, live_planning)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        observer_task = asyncio.create_task(monitor.run())
        try:
            yield
        finally:
            observer_task.cancel()
            with suppress(asyncio.CancelledError):
                await observer_task
        mail_workspace.close()
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
    attach_project_routes(app, Projects(database))

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
        workspace = mail_workspace.status() if workspace_selected else None
        states = [] if workspace_selected else mail.statuses()
        configured = (
            bool(workspace and workspace["reachable"])
            if workspace_selected
            else any(provider.configured for provider in states)
        )
        return {
            "version": __version__,
            "timezone": TIMEZONE,
            "providers": states,
            "mail_source": "workspace" if workspace_selected else "basic",
            "mail_workspace": workspace,
            "capabilities": {
                "mail_read": configured,
                "mail_draft": (
                    not workspace_selected and configured and configuration.mail_draft_enabled
                ),
                "mail_archive": (
                    not workspace_selected and configured and configuration.mail_archive_enabled
                ),
                "agent_supervision": True,
            },
        }

    def overview_data() -> dict[str, Any]:
        now = utc_now()
        tasks = [task for task in records.tasks() if task.status not in {"done", "cancelled"}]
        workspace = mail_workspace.status() if workspace_selected else None
        return {
            "timezone": TIMEZONE,
            "as_of": now,
            "mail_source": "workspace" if workspace_selected else "basic",
            "mail_workspace": workspace,
            "counts": {
                "open": len(tasks),
                "overdue": sum(bool(task.due_at and task.due_at < now) for task in tasks),
                "urgent_mail": (
                    aggregate_count(workspace, "porPrioridad", "alta")
                    if workspace is not None
                    else mail.urgent_count()
                ),
                "waiting_review": sum(task.status == "waiting" for task in tasks),
            },
            "priorities": tasks[:10],
            "recent_checkins": records.checkins()[:7],
            "providers": [] if workspace_selected else mail.statuses(),
        }

    def require_basic_mail() -> None:
        if workspace_selected:
            raise ServiceError(
                409, "El correo se gestiona en el espacio de correo original; use esa fuente."
            )

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
        if payload.source_type == "mail":
            require_basic_mail()
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
        require_basic_mail()
        return mail.threads(q, category, limit=limit, offset=offset)

    @app.get("/v1/mail-workspace/status")
    def workspace_status() -> dict[str, Any]:
        return mail_workspace.status()

    @app.post("/v1/mail-workspace/query")
    def workspace_query(payload: WorkspaceQuery) -> dict[str, Any]:
        return mail_workspace.query(payload.action, payload.params)

    @app.post("/v1/mail-workspace/asset")
    def mail_asset(payload: MailAsset) -> Response:
        body, mime, name = read_asset(mail_workspace, payload)
        return Response(
            body,
            media_type=mime,
            headers={
                "x-mail-filename": name,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.post("/v1/mail-workspace/local")
    def workspace_local(payload: WorkspaceQuery) -> dict[str, Any]:
        return mail_workspace.local(payload.action, payload.params)

    @app.post("/v1/mail-workspace/tasks", status_code=201)
    def workspace_capture(payload: WorkspaceCapture) -> Task:
        return mail_workspace.capture(payload)

    @app.post("/v1/mail/sync")
    def sync_mail(payload: SyncInput) -> dict[str, str | int]:
        require_basic_mail()
        return {"count": mail.sync(payload.provider), "provider": payload.provider}

    @app.patch("/v1/mail/threads/{identifier}")
    def categorize(identifier: str, payload: CategorizeInput) -> MailThread:
        require_basic_mail()
        return mail.categorize(identifier, payload.category)

    @app.post("/v1/mail/threads/{identifier}/task")
    def capture(identifier: str, payload: CaptureInput) -> Task:
        require_basic_mail()
        return mail.capture(identifier, payload)

    @app.post("/v1/mail/threads/{identifier}/draft")
    def draft(identifier: str, payload: DraftInput) -> DraftResult:
        require_basic_mail()
        if not configuration.mail_draft_enabled:
            raise ServiceError(403, "El operador no habilitó la creación de borradores.")
        return mail.draft(identifier, payload.body)

    @app.post("/v1/mail/threads/{identifier}/archive")
    def archive(identifier: str, payload: ConfirmInput) -> dict[str, str | bool]:
        require_basic_mail()
        if not configuration.mail_archive_enabled:
            raise ServiceError(403, "El operador no habilitó el archivo de correos.")
        return mail.archive(identifier)

    @app.post("/v1/mail/actions/{action_id}/undo")
    def undo(action_id: str, payload: ConfirmInput) -> dict[str, bool]:
        require_basic_mail()
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
        if workspace_selected:
            workspace = data["mail_workspace"]
            if workspace["reachable"]:
                parts = []
                for group, key, label in (
                    ("porEstado", "debo_respuesta", "por responder"),
                    ("porEstado", "esperando_respuesta", "esperando respuesta"),
                    ("porPrioridad", "alta", "de prioridad alta"),
                ):
                    count = aggregate_count(workspace, group, key)
                    parts.append(f"{count if count is not None else 'Sin verificar'} {label}")
                lines.append("Correo original: " + "; ".join(parts) + ".")
            else:
                lines.append("Espacio de correo original no disponible; pendientes sin verificar.")
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

    attach_planning_routes(app, live_planning, monitor)
    return app
