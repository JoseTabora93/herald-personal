import asyncio
import json
from contextlib import suppress
from unittest.mock import Mock

from herald_personal.live_observer import LiveObserver


def test_live_monitor_reports_health_and_never_accepts_runtime_commands(tmp_path):
    path = tmp_path / "observer.json"
    path.write_text(json.dumps({"workspaces": {"project": str(tmp_path)}}))
    path.chmod(0o600)
    planning = Mock()
    poller = Mock(return_value={"observed": 2, "errors": []})
    monitor = LiveObserver(path, planning, poller=poller)
    monitor.tick()
    assert poller.call_count == 1
    assert monitor.snapshot()["last_poll_at"]
    assert monitor.snapshot()["interval_seconds"] == 5
    assert monitor.snapshot()["errors"] == []
    poller.side_effect = RuntimeError("PRIVATE")
    monitor.tick()
    assert monitor.snapshot()["errors"] == ["observer_unavailable"]
    assert "PRIVATE" not in str(monitor.snapshot())


def test_disabled_monitor_does_not_read_or_poll(tmp_path):
    poller = Mock()
    monitor = LiveObserver(None, Mock(), poller=poller)
    monitor.tick()
    assert monitor.snapshot()["configured"] is False
    poller.assert_not_called()


def test_writable_config_fails_closed_and_shutdown_stops_loop(tmp_path):
    path = tmp_path / "observer.json"
    path.write_text("{}")
    path.chmod(0o644)
    poller = Mock()
    monitor = LiveObserver(path, Mock(), poller=poller)
    monitor.tick()
    poller.assert_not_called()
    assert monitor.snapshot()["errors"] == ["observer_unavailable"]

    async def lifecycle():
        task = asyncio.create_task(monitor.run())
        await asyncio.sleep(0.02)
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    asyncio.run(lifecycle())


def test_api_exposes_actual_live_monitor_status(settings):
    from fastapi.testclient import TestClient

    from herald_personal.api import create_app

    with TestClient(create_app(settings, providers={})) as client:
        response = client.get(
            "/v1/agent-observations", headers={"Authorization": "Bearer " + settings.api_token}
        )
        assert response.json()["monitor"]["configured"] is False
