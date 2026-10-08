import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from herald_personal.api import create_app
from herald_personal.config import Settings


def test_health_is_public_but_every_personal_route_fails_closed(tmp_path: Path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
        for path in ["status", "overview", "tasks", "mail/threads", "checkins", "brief"]:
            response = client.get(f"/v1/{path}", headers={"Authorization": "Bearer arbitrary"})
            assert response.status_code == 503
            assert isinstance(response.json()["detail"], str)


@pytest.mark.parametrize("header", [None, "Bearer wrong", "Basic test-local-bearer", "Bearer"])
def test_requires_valid_bearer_for_reads_and_writes(settings: Settings, header):
    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": header} if header else {}
        assert client.get("/v1/tasks", headers=headers).status_code == 401
        assert client.post("/v1/tasks", json={"title": "No"}, headers=headers).status_code == 401


def test_unconfigured_providers_and_empty_records_are_honest(client: TestClient):
    status = client.get("/v1/status").json()
    assert status["timezone"] == "America/Tegucigalpa"
    assert len(status["providers"]) == 2
    assert all(not p["configured"] and not p["connected"] for p in status["providers"])
    assert all(p["error"] for p in status["providers"])
    assert status["capabilities"]["mail_draft"] is False
    assert client.get("/v1/tasks").json() == {"items": []}
    assert client.get("/v1/mail/threads").json()["items"] == []
    assert client.post("/v1/mail/sync", json={"provider": "gmail"}).status_code == 503


def test_idempotent_creation_conflict_revision_and_audit_survive_restart(
    client: TestClient, settings: Settings
):
    payload = {"title": "Confirmar entrega", "idempotency_key": "request-01"}
    created = client.post("/v1/tasks", json=payload)
    assert created.status_code == 201
    task = created.json()
    assert task["status"] == "inbox" and task["revision"] == 1
    assert client.post("/v1/tasks", json=payload).json() == task
    changed_key = client.post("/v1/tasks", json={**payload, "title": "Otra entrega"})
    assert changed_key.status_code == 409
    updated = client.patch(
        f"/v1/tasks/{task['id']}", json={"status": "next", "expected_revision": 1}
    ).json()
    assert updated["revision"] == 2
    stale = client.patch(
        f"/v1/tasks/{task['id']}", json={"title": "Lost edit", "expected_revision": 1}
    )
    assert stale.status_code == 409
    assert client.post("/v1/tasks", json=payload).json() == task
    with TestClient(create_app(settings)) as restarted:
        restarted.headers["Authorization"] = "Bearer test-local-bearer"
        assert restarted.get(f"/v1/tasks/{task['id']}").json() == updated
        events = restarted.get(f"/v1/tasks/{task['id']}/events").json()["items"]
        assert [e["kind"] for e in events] == ["created", "updated"]
        assert all(isinstance(e["detail"], str) for e in events)


def test_concurrent_retries_create_one_task_and_one_audit_event(client: TestClient):
    def create(_):
        return client.post(
            "/v1/tasks", json={"title": "Only once", "idempotency_key": "concurrent"}
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(create, range(8)))
    assert all(r.status_code in {200, 201} for r in results)
    ids = {r.json()["id"] for r in results}
    assert len(ids) == 1
    assert len(client.get("/v1/tasks").json()["items"]) == 1
    assert len(client.get(f"/v1/tasks/{ids.pop()}/events").json()["items"]) == 1


def test_date_only_due_date_keeps_local_calendar_date_and_naive_time_rejected(client):
    task = client.post("/v1/tasks", json={"title": "Viernes", "due_at": "2026-10-09"}).json()
    assert task["due_at"] == "2026-10-10T05:59:59Z"
    assert (
        client.post(
            "/v1/tasks", json={"title": "Invalid", "due_at": "2026-10-09T10:00:00"}
        ).status_code
        == 422
    )
    assert (
        client.post("/v1/tasks", json={"title": "Invalid", "due_at": "2026-02-30"}).status_code
        == 422
    )


@pytest.mark.parametrize(
    "body",
    [
        {"title": "   "},
        {"title": "x" * 501},
        {"title": "x", "status": "admin"},
        {"title": "x", "execute": "rm -rf /"},
        {"title": "x", "source_type": "mail"},
    ],
)
def test_task_input_boundaries_and_extra_fields_are_rejected(client, body):
    response = client.post("/v1/tasks", json=body)
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)


def test_search_is_literal_and_does_not_change_database(client):
    client.post("/v1/tasks", json={"title": "100% pendiente"})
    client.post("/v1/tasks", json={"title": "Otra tarea"})
    assert len(client.get("/v1/tasks", params={"q": "%"}).json()["items"]) == 1
    assert client.get("/v1/tasks", params={"q": "' OR 1=1; --"}).json()["items"] == []
    assert len(client.get("/v1/tasks").json()["items"]) == 2
    assert client.get("/v1/tasks/missing").status_code == 404


def test_checkin_upsert_has_history_and_never_completes_tasks(client, settings):
    task = client.post("/v1/tasks", json={"title": "Entregado"}).json()
    body = {"accomplished": "Entregado", "pending": "Esperar", "tomorrow": "Revisar"}
    first = client.put("/v1/checkins/2026-10-08", json=body).json()
    second = client.put(
        "/v1/checkins/2026-10-08", json={**body, "pending": "Confirmar recibo"}
    ).json()
    assert first["id"] == second["id"]
    assert len(client.get("/v1/checkins").json()["items"]) == 1
    assert client.get(f"/v1/tasks/{task['id']}").json()["status"] == "inbox"
    assert client.put("/v1/checkins/2026-02-30", json=body).status_code == 422
    with closing(sqlite3.connect(settings.data_dir / "personal.sqlite3")) as db:
        history = db.execute("SELECT COUNT(*) FROM checkin_events").fetchone()[0]
        assert history == 2
        assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"


def test_overview_and_briefs_use_real_records(client):
    urgent = client.post(
        "/v1/tasks",
        json={"title": "Cotización", "priority": "high", "status": "next", "due_at": "2000-01-01"},
    ).json()
    closed = client.post("/v1/tasks", json={"title": "Terminado", "status": "done"}).json()
    overview = client.get("/v1/overview").json()
    assert overview["counts"]["open"] == 1 and overview["counts"]["overdue"] == 1
    assert overview["priorities"][0]["id"] == urgent["id"]
    for kind in ["morning", "evening"]:
        brief = client.get("/v1/brief", params={"kind": kind}).json()
        assert "Cotización" in brief["text"]
        assert urgent["id"] in brief["source_ids"] and closed["id"] not in brief["source_ids"]
    assert client.get("/v1/brief?kind=invalid").status_code == 422


def test_briefs_describe_open_commitment_states_in_spanish(client):
    commitments = [
        ("Organizar notas", "inbox", "Por ordenar"),
        ("Preparar propuesta", "next", "Siguiente"),
        ("Revisar planos", "in_progress", "En curso"),
        ("Confirmación del cliente", "waiting", "En espera"),
    ]
    for title, status, _ in commitments:
        response = client.post("/v1/tasks", json={"title": title, "status": status})
        assert response.status_code == 201
    for kind in ("morning", "evening"):
        brief = client.get("/v1/brief", params={"kind": kind}).json()["text"]
        for title, status, label in commitments:
            assert f"{title} ({label})" in brief
            assert f"({status})" not in brief
