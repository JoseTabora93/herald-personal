"""Project follow-up must preserve tasks and separate execution from delivery evidence."""

from copy import deepcopy
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from herald_personal.api import create_app


def stamp(seconds=0):
    return (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat()


def snapshot(**overrides):
    result = {
        "project": "Fixture Campo",
        "label": "Cezar + GitHub",
        "attempted_at": stamp(),
        "source_updated_at": stamp(-10),
        "interval_seconds": 900,
        "warnings": [],
        "items": [
            {
                "key": "fixture-n3",
                "title": "CLI importador",
                "run_id": "fixture-n3",
                "run_status": "completed",
                "branch": "feat/cli",
            },
            {
                "key": "fixture-n4",
                "title": "Hoja de cálculo",
                "run_id": "fixture-n4",
                "run_status": "completed",
                "branch": "feat/tab",
                "pr": {
                    "repository": "example/fixture",
                    "number": 16,
                    "state": "MERGED",
                    "updated_at": stamp(-50),
                },
            },
        ],
    }
    return result | overrides


def sync(client, body):
    return client.put("/v1/project-sources/fixture-build", json=body)


def project(client):
    result = client.get("/v1/projects")
    assert result.status_code == 200
    return result.json()["items"][0]


def test_projects_include_closed_tasks_and_manual_projects(client):
    for status in ("done", "waiting"):
        assert (
            client.post(
                "/v1/tasks", json={"title": status, "project": "Manual", "status": status}
            ).status_code
            == 201
        )
    item = project(client)
    assert item["name"] == "Manual"
    assert item["counts"]["total"] == 2
    assert item["counts"]["closed"] == 1
    assert len(item["items"]) == 2
    assert item["sources"] == []


def test_sync_adopts_legacy_tasks_without_duplicates_and_repairs_details(client, settings):
    legacy = client.post(
        "/v1/tasks",
        json={
            "title": "Old",
            "description": "PR PENDIENTE",
            "priority": "high",
            "source_type": "agent",
            "source_id": "fixture-n4",
            "project": "Fixture Campo",
            "due_at": "2026-12-01",
        },
    ).json()
    body = snapshot()
    assert sync(client, body).status_code == 200
    assert sync(client, body).status_code == 200
    with TestClient(create_app(settings)) as restarted:
        restarted.headers["Authorization"] = "Bearer test-local-bearer"
        item = project(restarted)
        tasks = restarted.get("/v1/tasks").json()["items"]
    assert len(tasks) == 2
    adopted = next(t for t in tasks if t["id"] == legacy["id"])
    assert adopted["priority"] == "normal"
    assert adopted["status"] == "done"
    assert adopted["due_at"] == legacy["due_at"]
    assert "#16" in adopted["description"] and "PENDIENTE" not in adopted["description"]
    assert item["counts"] == {
        "total": 2,
        "closed": 1,
        "running": 0,
        "attention": 1,
        "review": 0,
        "merged": 1,
    }
    assert item["items"][0]["verification"] == "not_run"
    assert len(client.get(f"/v1/tasks/{legacy['id']}/events").json()["items"]) == 2


def test_completed_process_without_pr_is_attention_and_open_pr_is_review(client):
    body = snapshot()
    body["items"][1]["pr"]["state"] = "OPEN"
    assert sync(client, body).status_code == 200
    item = project(client)
    assert {i["stage"] for i in item["items"]} == {"attention", "review"}
    assert item["counts"]["closed"] == 0
    assert item["counts"]["review"] == 1
    assert all(i["verification"] == "not_run" for i in item["items"])


def test_failed_poll_retains_evidence_but_never_claims_current_running(client):
    first = snapshot()
    first["items"][0]["run_status"] = "running"
    assert sync(client, first).status_code == 200
    assert project(client)["counts"]["running"] == 1
    failed = snapshot(items=[], error="source_unavailable")
    assert sync(client, failed).status_code == 200
    item = project(client)
    assert item["counts"]["total"] == 2
    assert item["counts"]["running"] == 0
    assert item["sources"][0]["health"] == "error"
    assert item["sources"][0]["last_success_at"] == first["attempted_at"]
    assert any(i["pr"] and i["pr"]["state"] == "MERGED" for i in item["items"])


def test_stale_feed_unknown_timezone_and_missing_runs_are_not_live(client):
    for source_time in (stamp(-4000), None):
        body = snapshot(source_updated_at=source_time)
        body["items"][0]["run_status"] = "running"
        assert sync(client, body).status_code == 200
        assert project(client)["counts"]["running"] == 0
    body = snapshot()
    body["items"][0]["run_status"] = "running"
    assert sync(client, body).status_code == 200
    assert project(client)["counts"]["running"] == 1
    assert sync(client, snapshot(items=body["items"][1:])).status_code == 200
    item = project(client)
    assert item["counts"]["total"] == 2
    assert item["counts"]["running"] == 0
    missing = next(i for i in item["items"] if i["run_id"] == "fixture-n3")
    assert missing["missing"] is True


def test_old_poll_cannot_overwrite_newer_evidence(client):
    body = snapshot()
    assert sync(client, body).status_code == 200
    older = deepcopy(body)
    older["attempted_at"] = stamp(-100)
    older["items"][1]["pr"]["state"] = "OPEN"
    assert sync(client, older).status_code == 409
    assert project(client)["counts"]["merged"] == 1


def test_github_failure_keeps_last_confirmed_pr_and_its_check_time(client):
    first = snapshot()
    assert sync(client, first).status_code == 200
    second = snapshot(github_error=True)
    second["items"][1].pop("pr")
    assert sync(client, second).status_code == 200
    item = project(client)
    assert item["counts"]["merged"] == 1
    evidence = next(i for i in item["items"] if i["pr"])
    assert evidence["pr_checked_at"] == first["attempted_at"]
    assert item["sources"][0]["health"] == "partial"


def test_no_foreign_task_adoption_and_atomic_duplicate_rejection(client):
    client.post(
        "/v1/tasks",
        json={
            "title": "Other",
            "source_type": "agent",
            "source_id": "fixture-n4",
            "project": "Other",
        },
    )
    assert sync(client, snapshot()).status_code == 409
    assert len(client.get("/v1/tasks").json()["items"]) == 1
    duplicated = snapshot()
    duplicated["items"].append(duplicated["items"][0])
    assert sync(client, duplicated).status_code == 422
    assert len(client.get("/v1/tasks").json()["items"]) == 1


def test_project_endpoints_require_auth_and_reject_urls_and_future_poll(client):
    assert client.get("/v1/projects", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert (
        client.put(
            "/v1/project-sources/fixture-build",
            json=snapshot(),
            headers={"Authorization": "Bearer wrong"},
        ).status_code
        == 401
    )
    bad = snapshot()
    bad["items"][1]["pr"]["repository"] = "example/fixture/../../evil"
    assert sync(client, bad).status_code == 422
    assert sync(client, snapshot(attempted_at=stamp(600))).status_code == 422
    bad = snapshot(source_updated_at="2026-10-10T19:00:00")
    assert sync(client, bad).status_code == 422


def test_source_expiry_uses_server_clock(client):
    body = snapshot(attempted_at=stamp(-4000), source_updated_at=stamp(-4005))
    body["items"][0]["run_status"] = "running"
    assert sync(client, body).status_code == 200
    item = project(client)
    assert item["counts"]["running"] == 0
    assert item["sources"][0]["health"] == "stale"


def test_equal_attempt_with_different_content_is_a_conflict(client):
    body = snapshot()
    assert sync(client, body).status_code == 200
    body["items"][1]["pr"]["state"] = "OPEN"
    assert sync(client, body).status_code == 409
    assert project(client)["counts"]["merged"] == 1


def test_github_only_item_is_not_reported_missing_during_a_github_outage(client):
    first = snapshot()
    first["items"][1]["run_id"] = None
    assert sync(client, first).status_code == 200
    assert sync(client, snapshot(items=first["items"][:1], github_error=True)).status_code == 200
    previous = next(i for i in project(client)["items"] if i["pr"])
    assert previous["missing"] is False


def test_migration_preserves_v3_tasks(settings):
    from herald_personal.database import Database
    from herald_personal.models import TaskCreate
    from herald_personal.records import Records

    database = Database(settings.data_dir)
    task = Records(database).create_task(TaskCreate(title="Before migration", project="Manual"))
    with database.connection() as connection:
        connection.executescript(
            "DROP TABLE project_direction_events; DROP TABLE project_directions; "
            "DROP TABLE project_conversations; "
            "DROP TABLE project_items; DROP TABLE project_sources; PRAGMA user_version=3;"
        )
    upgraded = Database(settings.data_dir)
    assert Records(upgraded).get_task(task.id) == task
    with upgraded.connection() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 5
