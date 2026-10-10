"""Conversation links and user direction are independent of imported project facts."""

from typing import Annotated, Any
from uuid import uuid4

from fastapi import FastAPI, Path
from pydantic import Field

from .database import Database
from .errors import ServiceError
from .models import InputModel, Title, utc_now
from .projects import Projects

ProjectId = Annotated[str, Path(pattern=r"^[a-f0-9]{24}$")]


class ConversationLink(InputModel):
    session_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$")
    title: Title


class DirectionUpdate(InputModel):
    text: str = Field(max_length=6000)
    expected_revision: int = Field(strict=True, ge=0)


class ProjectWorkspace:
    def __init__(self, database: Database):
        self.db = database
        self.projects = Projects(database)

    def project(self, project_id: str) -> dict[str, Any]:
        project = next((p for p in self.projects.list()["items"] if p["id"] == project_id), None)
        if project is None:
            raise ServiceError(404, "Proyecto no disponible.")
        return dict(project)

    def read(self, project_id: str) -> dict[str, Any]:
        project = self.project(project_id)
        with self.db.connection() as connection:
            conversations = [
                dict(row)
                for row in connection.execute(
                    "SELECT session_id,title,created_at FROM project_conversations "
                    "WHERE project_id=? ORDER BY created_at DESC,rowid DESC",
                    (project_id,),
                )
            ]
            direction = connection.execute(
                "SELECT text,revision,updated_at FROM project_directions WHERE project_id=?",
                (project_id,),
            ).fetchone()
            events = [
                dict(row)
                for row in connection.execute(
                    "SELECT id,text,revision,created_at FROM project_direction_events "
                    "WHERE project_id=? ORDER BY revision DESC LIMIT 10",
                    (project_id,),
                )
            ]
        return {
            "project": project,
            "conversations": conversations,
            "direction": {
                **(
                    dict(direction)
                    if direction
                    else {"text": "", "revision": 0, "updated_at": None}
                ),
                "delivery": "local",
            },
            "events": events,
        }

    def link(self, project_id: str, body: ConversationLink) -> dict[str, Any]:
        self.project(project_id)
        with self.db.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM project_conversations WHERE session_id=?", (body.session_id,)
            ).fetchone()
            if row and row["project_id"] != project_id:
                raise ServiceError(409, "La conversación pertenece a otro proyecto.")
            if not row:
                connection.execute(
                    "INSERT INTO project_conversations VALUES(?,?,?,?)",
                    (body.session_id, project_id, body.title, utc_now()),
                )
        return self.read(project_id)

    def update_direction(self, project_id: str, body: DirectionUpdate) -> dict[str, Any]:
        self.project(project_id)
        text = body.text.strip()
        with self.db.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM project_directions WHERE project_id=?", (project_id,)
            ).fetchone()
            revision = row["revision"] if row else 0
            if row and row["text"] == text:
                return {
                    "text": text,
                    "revision": revision,
                    "updated_at": row["updated_at"],
                    "delivery": "local",
                }
            if revision != body.expected_revision:
                raise ServiceError(409, "El rumbo cambió. Vuelve a leerlo antes de editar.")
            now = utc_now()
            revision += 1
            connection.execute(
                "INSERT INTO project_directions VALUES(?,?,?,?) ON CONFLICT(project_id) "
                "DO UPDATE SET text=excluded.text,revision=excluded.revision,"
                "updated_at=excluded.updated_at",
                (project_id, text, revision, now),
            )
            connection.execute(
                "INSERT INTO project_direction_events VALUES(?,?,?,?,?)",
                (str(uuid4()), project_id, text, revision, now),
            )
        return {"text": text, "revision": revision, "updated_at": now, "delivery": "local"}


def attach_project_workspace_routes(app: FastAPI, workspace: ProjectWorkspace) -> None:
    @app.get("/v1/projects/{project_id}/workspace")
    def read(project_id: ProjectId) -> dict[str, Any]:
        return workspace.read(project_id)

    @app.post("/v1/projects/{project_id}/conversations")
    def link(project_id: ProjectId, body: ConversationLink) -> dict[str, Any]:
        return workspace.link(project_id, body)

    @app.put("/v1/projects/{project_id}/direction")
    def direction(project_id: ProjectId, body: DirectionUpdate) -> dict[str, Any]:
        return workspace.update_direction(project_id, body)
