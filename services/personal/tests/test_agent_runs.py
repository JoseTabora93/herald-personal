import sqlite3
from contextlib import closing
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from herald_personal.api import create_app


def snapshot(**changes):
    return {
        "run_id": str(uuid4()),
        "revision": 1,
        "scope_id": "coding-test",
        "task_id": None,
        "workspace": "herald-personal",
        "agent": "claude",
        "status": "running",
        "created_at": "2026-10-08T10:00:00Z",
        "updated_at": "2026-10-08T10:00:00Z",
        "verification": "not_run",
        "attempts": [
            {
                "number": 1,
                "status": "running",
                "started_at": "2026-10-08T10:00:00Z",
                "finished_at": None,
                "exit_code": None,
                "stdout_sha256": None,
                "stderr_sha256": None,
                "outcome": None,
            }
        ],
        **changes,
    }


def test_run_snapshot_idempotency_stale_conflicts_and_durable_audit(client, settings):
    value = snapshot()
    path = f"/v1/agent-runs/{value['run_id']}"
    first = client.put(path, json=value)
    assert first.status_code == 200
    assert client.put(path, json=value).json() == first.json()
    assert client.put(path, json={**value, "status": "cancel_requested"}).status_code == 409
    completed = {
        **value,
        "revision": 2,
        "status": "completed",
        "updated_at": "2026-10-08T11:00:00Z",
        "attempts": [
            {
                **value["attempts"][0],
                "status": "completed",
                "finished_at": "2026-10-08T11:00:00Z",
                "exit_code": 0,
                "stdout_sha256": "a" * 64,
                "stderr_sha256": "b" * 64,
            }
        ],
    }
    assert client.put(path, json=completed).status_code == 200
    assert client.put(path, json=value).status_code == 409
    with TestClient(create_app(settings)) as restarted:
        restarted.headers["Authorization"] = "Bearer test-local-bearer"
        result = restarted.get("/v1/agent-runs").json()["items"]
        assert len(result) == 1 and result[0]["status"] == "completed"
        assert result[0]["verification"] == "not_run"
    with closing(sqlite3.connect(settings.data_dir / "personal.sqlite3")) as database:
        assert database.execute("SELECT COUNT(*) FROM agent_run_events").fetchone()[0] == 2


def test_coding_completion_never_completes_human_commitment(client):
    task = client.post(
        "/v1/tasks", json={"title": "Revisar entrega", "status": "in_progress"}
    ).json()
    value = snapshot(task_id=task["id"], status="completed")
    value["attempts"][0].update(status="completed", finished_at="2026-10-08T10:00:00Z", exit_code=0)
    assert client.put(f"/v1/agent-runs/{value['run_id']}", json=value).status_code == 200
    assert client.get(f"/v1/tasks/{task['id']}").json()["status"] == "in_progress"
    assert client.get("/v1/status").json()["capabilities"]["agent_supervision"] is True


@pytest.mark.parametrize(
    "changes",
    [
        {"workspace": "/private/operator/path"},
        {"revision": True},
        {"verification": "passed"},
        {"created_at": "2026-10-08T10:00:00"},
        {"agent": "bash"},
        {"prompt": "execute secrets"},
        {"attempts": [{"number": 0}]},
        {"task_id": "missing"},
    ],
)
def test_snapshot_boundaries_and_missing_links_are_rejected(client, changes):
    value = snapshot(**changes)
    response = client.put(f"/v1/agent-runs/{value['run_id']}", json=value)
    assert response.status_code in {404, 422}
    assert client.get("/v1/agent-runs").json()["items"] == []


def test_run_identity_and_updated_time_cannot_regress(client):
    value = snapshot()
    path = f"/v1/agent-runs/{value['run_id']}"
    assert client.put(path, json=value).status_code == 200
    for changes in [
        {"scope_id": "other"},
        {"workspace": "other"},
        {"updated_at": "2026-10-07T10:00:00Z"},
    ]:
        assert client.put(path, json={**value, "revision": 2, **changes}).status_code in {409, 422}
    assert client.put(f"/v1/agent-runs/{uuid4()}", json=value).status_code == 422
