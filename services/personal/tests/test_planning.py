"""Daily decisions must survive retries without inventing activity or opening twice."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from herald_personal.api import create_app


def local_day() -> str:
    return datetime.now(ZoneInfo("America/Tegucigalpa")).date().isoformat()


def observation(**changes):
    now = datetime.now(UTC).isoformat()
    return {
        "observer_id": "opencode-fixture-1",
        "revision": 1,
        "observed_at": now,
        "agent": "opencode",
        "native_session_id": "ses_fixture_1",
        "workspace": "proyecto-sintetico",
        "status": "waiting_permission",
        "evidence_source": "opencode_api",
        "confidence": "high",
        "source_updated_at": now,
        "stale_after_seconds": 300,
        "signals": ["La API publica una solicitud de permiso pendiente."],
        "verification": "not_run",
        **changes,
    }


def save_observation(client, snapshot=None):
    value = snapshot or observation()
    return client.put(f"/v1/agent-observations/{value['observer_id']}", json=value)


def create_plan(client):
    result = client.post("/v1/daily-plans/generate", json={"date": local_day()})
    assert result.status_code in {200, 201}, result.text
    return result.json()


def test_observation_revision_identity_and_replay(client):
    snapshot = observation()
    assert save_observation(client, snapshot).status_code == 200
    assert save_observation(client, snapshot).status_code == 200
    assert save_observation(client, {**snapshot, "status": "active"}).status_code == 409
    assert save_observation(client, {**snapshot, "revision": 2}).status_code == 200
    assert save_observation(client, snapshot).status_code == 409
    assert (
        save_observation(client, {**snapshot, "revision": 3, "agent": "claude"}).status_code == 409
    )
    items = client.get("/v1/agent-observations").json()["items"]
    assert len(items) == 1
    assert items[0]["effective_status"] == "waiting_permission"
    assert items[0]["verification"] == "not_run"


def test_stale_snapshot_is_not_live_activity(client):
    old = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    assert (
        save_observation(client, observation(observed_at=old, source_updated_at=old)).status_code
        == 200
    )
    item = client.get("/v1/agent-observations").json()["items"][0]
    assert item["is_stale"] is True
    assert item["effective_status"] == "unknown"
    assert item["status"] == "waiting_permission"


def test_process_presence_cannot_claim_active_work_or_verification(client):
    assert (
        save_observation(
            client, observation(evidence_source="process_inventory", status="active")
        ).status_code
        == 422
    )
    assert save_observation(client, observation(verification="passed")).status_code == 422
    assert save_observation(client, observation(prompt="private prompt")).status_code == 422
    assert save_observation(client, observation(signals=["x" * 251])).status_code == 422
    future = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    assert save_observation(client, observation(observed_at=future)).status_code == 422


def test_daily_plan_is_one_durable_snapshot_not_a_task_mutation(client, settings):
    task = client.post(
        "/v1/tasks",
        json={"title": "Revisar propuesta sintética", "priority": "high", "status": "next"},
    ).json()
    assert save_observation(client).status_code == 200
    plan = create_plan(client)
    assert plan["date"] == local_day()
    assert plan["timezone"] == "America/Tegucigalpa"
    assert plan["revision"] == 1
    assert plan["verification"] == "not_run"
    assert plan["status"] == "partial"
    assert any(item["source_ref"] == f"task:{task['id']}" for item in plan["priorities"])
    assert any(
        item["id"] == "mail-workspace" and item["status"] == "unavailable"
        for item in plan["sources"]
    )
    assert any("permiso" in item["reason"].lower() for item in plan["recommendations"])
    assert any("calendario" in text.lower() for text in plan["limitations"])
    assert create_plan(client) == plan
    assert client.get(f"/v1/tasks/{task['id']}").json()["status"] == "next"
    with TestClient(
        create_app(settings), headers={"Authorization": "Bearer test-local-bearer"}
    ) as restarted:
        assert restarted.get("/v1/daily-plans", params={"date": local_day()}).json()["items"] == [
            plan
        ]
        assert len(restarted.get("/v1/agent-observations").json()["items"]) == 1


def test_recommendations_require_known_evidence_and_current_revision(client):
    client.post("/v1/tasks", json={"title": "Prioridad comprobable", "status": "next"})
    plan = create_plan(client)
    endpoint = f"/v1/daily-plans/{local_day()}/recommendations"
    data = {
        "expected_revision": 1,
        "summary": "Reserva un bloque para tu prioridad.",
        "model": "fixture-model",
        "recommendations": [
            {
                "title": "Revisar la prioridad",
                "reason": "Está pendiente en tus compromisos.",
                "evidence_refs": [plan["priorities"][0]["source_ref"]],
            }
        ],
    }
    unknown = {
        **data,
        "recommendations": [{**data["recommendations"][0], "evidence_refs": ["inventado:1"]}],
    }
    assert client.put(endpoint, json=unknown).status_code == 422
    changed = client.put(endpoint, json=data)
    assert changed.status_code == 200
    assert changed.json()["revision"] == 2
    assert changed.json()["model"] == "fixture-model"
    assert changed.json()["recommendations"][0]["author"] == "hermes"
    assert changed.json()["verification"] == "not_run"
    assert client.put(endpoint, json=data).status_code == 409
    assert create_plan(client) == changed.json()


def test_open_claim_is_single_use_and_survives_restart(client, settings):
    create_plan(client)
    endpoint = f"/v1/daily-plans/{local_day()}/open-claim"
    payload = {"owner": "mac-fixture", "attempt_id": "attempt-fixture-1"}
    assert client.post(endpoint, json=payload).json() == {"claimed": True}
    assert client.post(endpoint, json=payload).json() == {"claimed": False}
    with TestClient(
        create_app(settings), headers={"Authorization": "Bearer test-local-bearer"}
    ) as restarted:
        assert restarted.post(
            endpoint, json={**payload, "attempt_id": "attempt-fixture-2"}
        ).json() == {"claimed": False}


def test_model_claim_and_failure_preserve_the_base_plan_without_retrying(client):
    plan = create_plan(client)
    base = f"/v1/daily-plans/{local_day()}"
    payload = {"owner": "daily-job", "attempt_id": "model-attempt-1"}
    assert client.post(base + "/model-claim", json=payload).json() == {"claimed": True}
    assert client.post(base + "/model-claim", json=payload).json() == {"claimed": False}
    response = client.post(base + "/model-error", json={"error": "provider_error"})
    assert response.status_code == 200
    assert response.json()["priorities"] == plan["priorities"]
    assert response.json()["model_error"] == "provider_error"
    assert (
        client.post(base + "/model-error", json={"error": "raw secret response"}).status_code == 422
    )


def test_concurrent_open_claims_have_one_winner(client):
    create_plan(client)
    endpoint = f"/v1/daily-plans/{local_day()}/open-claim"
    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(
            pool.map(
                lambda n: client.post(
                    endpoint, json={"owner": "mac-fixture", "attempt_id": f"attempt-{n}"}
                ).json(),
                range(5),
            )
        )
    assert sum(result["claimed"] for result in results) == 1


def test_planning_endpoints_fail_closed_and_validate_dates(client):
    assert client.get("/v1/daily-plans", params={"date": "2026-99-99"}).status_code == 422
    assert client.post("/v1/daily-plans/generate", json={"date": "2026-99-99"}).status_code == 422
    assert (
        client.post(
            "/v1/daily-plans/2026-01-01/open-claim",
            json={"owner": "fixture", "attempt_id": "missing"},
        ).status_code
        == 404
    )
    client.headers.pop("Authorization")
    assert client.get("/v1/daily-plans").status_code == 401
    assert client.get("/v1/agent-observations").status_code == 401
    assert client.post("/v1/daily-plans/generate", json={}).status_code == 401
