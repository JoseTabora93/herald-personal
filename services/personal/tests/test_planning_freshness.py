"""A recent polling time cannot turn failed mail sync or unknown agents into a ready plan."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from herald_personal.api import create_app


def plan_with_evidence(settings, *, sync_state="ok", future_sync=False, unknown=None):
    now = datetime.now(UTC)
    synced = now + timedelta(hours=1) if future_sync else now
    counts = {
        "total": 3,
        "porEstado": {"debo_respuesta": 2, "esperando_respuesta": 1},
        "porPrioridad": {"alta": 1, "media": 2, "baja": 0},
        "ultimaSincronizacion": {"fin": synced.isoformat(), "estado": sync_state},
    }

    def handler(request):
        assert request.method == "GET"
        assert request.url.path == "/_agent-native/actions/mail-counts"
        return httpx.Response(200, json=counts)

    configured = settings.model_copy(update={"mail_workspace_url": "http://127.0.0.1:8097"})
    with (
        httpx.Client(transport=httpx.MockTransport(handler)) as transport,
        TestClient(
            create_app(configured, mail_workspace_client=transport),
            headers={"Authorization": "Bearer test-local-bearer"},
        ) as client,
    ):
        observed = now - timedelta(hours=1) if unknown == "stale" else now
        snapshot = {
            "observer_id": "fixture-observer",
            "revision": 1,
            "observed_at": observed.isoformat(),
            "agent": "opencode",
            "native_session_id": "fixture-session",
            "workspace": "fixture-workspace",
            "status": "unknown" if unknown == "unavailable" else "active",
            "evidence_source": "unavailable" if unknown == "unavailable" else "opencode_api",
            "confidence": "low" if unknown == "unavailable" else "high",
        }
        assert (
            client.put("/v1/agent-observations/fixture-observer", json=snapshot).status_code == 200
        )
        response = client.post("/v1/daily-plans/generate", json={})
        assert response.status_code == 200
        return response.json()


@pytest.mark.parametrize(
    ("sync_state", "future_sync"), [("error", False), ("parcial", False), ("ok", True)]
)
def test_mail_sync_failure_or_future_timestamp_never_produces_ready_plan(
    settings, sync_state, future_sync
):
    plan = plan_with_evidence(settings, sync_state=sync_state, future_sync=future_sync)
    assert plan["status"] == "partial"
    mail = next(source for source in plan["sources"] if source["kind"] == "mail_workspace")
    assert mail["status"] != "available"
    assert plan["verification"] == "not_run"


@pytest.mark.parametrize("unknown", ["stale", "unavailable"])
def test_only_unknown_agent_evidence_keeps_the_plan_partial(settings, unknown):
    plan = plan_with_evidence(settings, unknown=unknown)
    assert plan["status"] == "partial"
    assert plan["agent_summary"] == {"active": 0, "attention": 0, "unknown": 1}
    assert plan["verification"] == "not_run"
