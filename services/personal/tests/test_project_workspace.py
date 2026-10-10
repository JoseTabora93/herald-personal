"""A project conversation and its direction survive restarts and source refreshes."""

from fastapi.testclient import TestClient
from test_projects import project, snapshot, sync

from herald_personal.api import create_app


def workspace_url(client):
    return f"/v1/projects/{project(client)['id']}/workspace"


def test_workspace_sessions_are_durable_idempotent_and_isolated(client, settings):
    assert sync(client, snapshot()).status_code == 200
    url = workspace_url(client)
    empty = client.get(url)
    assert empty.status_code == 200
    assert empty.json()["conversations"] == []
    body = {"session_id": "fixture-session", "title": "Primera conversación"}
    endpoint = url.replace("workspace", "conversations")
    assert client.post(endpoint, json=body).status_code == 200
    assert client.post(endpoint, json=body).status_code == 200
    client.post("/v1/tasks", json={"title": "Otro", "project": "Other"})
    other = next(p for p in client.get("/v1/projects").json()["items"] if p["name"] == "Other")
    assert client.post(f"/v1/projects/{other['id']}/conversations", json=body).status_code == 409
    with TestClient(create_app(settings)) as restarted:
        restarted.headers["Authorization"] = "Bearer test-local-bearer"
        saved = restarted.get(url).json()
        assert saved["conversations"][0]["session_id"] == body["session_id"]
        assert len(saved["conversations"]) == 1
        assert restarted.get(f"/v1/projects/{other['id']}/workspace").json()["conversations"] == []


def test_direction_is_audited_versioned_and_not_overwritten_by_source(client):
    sync(client, snapshot())
    url = workspace_url(client)
    endpoint = url.replace("workspace", "direction")
    command = {"text": "Atender primero el importador; después el PDF.", "expected_revision": 0}
    result = client.put(endpoint, json=command)
    assert result.status_code == 200
    assert result.json()["revision"] == 1
    assert result.json()["delivery"] == "local"
    assert client.put(endpoint, json=command).status_code == 200
    assert (
        client.put(endpoint, json={"text": "Otro rumbo", "expected_revision": 0}).status_code == 409
    )
    sync(client, snapshot())
    saved = client.get(url).json()
    assert saved["direction"]["text"] == command["text"]
    assert len(saved["events"]) == 1
    assert client.put(endpoint, json={"text": "", "expected_revision": 1}).status_code == 200
    assert len(client.get(url).json()["events"]) == 2


def test_workspace_auth_unknown_project_and_untrusted_input(client):
    sync(client, snapshot())
    url = workspace_url(client)
    assert client.get(url, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/v1/projects/000000000000000000000000/workspace").status_code == 404
    assert (
        client.post(
            url.replace("workspace", "conversations"),
            json={"session_id": "../escape", "title": "Bad"},
        ).status_code
        == 422
    )
    assert (
        client.put(
            url.replace("workspace", "direction"), json={"text": "x" * 6001, "expected_revision": 0}
        ).status_code
        == 422
    )
    assert (
        client.put(
            url.replace("workspace", "direction"), json={"text": "X", "expected_revision": True}
        ).status_code
        == 422
    )
