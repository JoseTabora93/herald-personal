"""Remote read adapter: bounded GitHub command, missing telemetry and safe errors."""

import json
import subprocess
from unittest.mock import patch

import httpx
import pytest


def config(tmp_path):
    from herald_personal.project_sync import SyncConfig

    return SyncConfig(
        project="Fixture Campo",
        source_id="fixture-build",
        label="Cezar + GitHub",
        status_url="https://example.com/status.json",
        repository="example/fixture",
        gh_path="/opt/bin/gh",
        connection_file=tmp_path / "connection.json",
        run_metadata={"n4": {"title": "Hoja de cálculo", "branch": "feat/tab"}},
        tracked_prs=[22],
    )


def test_adapter_matches_all_pr_states_and_includes_explicitly_tracked_pr(tmp_path):
    from herald_personal.project_sync import build_snapshot

    cfg = config(tmp_path)
    feed = {
        "generado": "2026-10-10T12:00:00Z",
        "runs": [{"id": "n4", "nombre": "N4", "status": "done", "pr": []}],
    }
    prs = [
        {
            "number": 16,
            "state": "MERGED",
            "headRefName": "feat/tab",
            "title": "Tab",
            "updatedAt": "2026-10-10T11:00:00Z",
        },
        {
            "number": 22,
            "state": "OPEN",
            "headRefName": "feat/pdf",
            "title": "PDF v3",
            "updatedAt": "2026-10-10T11:01:00Z",
        },
    ]
    result = build_snapshot(cfg, feed, prs)
    assert len(result.items) == 2
    assert result.items[0].pr.number == 16
    assert result.items[0].title == "Hoja de cálculo"
    assert result.items[1].pr.number == 22
    assert result.items[1].run_id is None
    assert result.items[1].run_status == "unknown"


def test_naive_timestamp_never_becomes_a_live_utc_heartbeat(tmp_path):
    from herald_personal.project_sync import build_snapshot

    result = build_snapshot(
        config(tmp_path),
        {"generado": "2026-10-10T19:10:00", "runs": [{"id": "n4", "status": "running"}]},
        [],
    )
    assert result.source_updated_at is None
    assert any("zona horaria" in w for w in result.warnings)


def test_requested_work_without_telemetry_remains_visible_without_fabricating_a_run(tmp_path):
    from herald_personal.project_sync import SyncConfig, build_snapshot

    cfg = SyncConfig.model_validate(
        config(tmp_path).model_dump()
        | {"tracked_work": [{"key": "phase-one", "title": "Fase 1 FSM"}]}
    )
    result = build_snapshot(cfg, {"runs": [], "generado": None}, [])
    item = result.items[0]
    assert item.title == "Fase 1 FSM"
    assert item.run_id is None and item.run_status == "unknown" and item.pr is None


def test_github_uses_absolute_executable_timeout_and_never_treats_errors_as_no_pr(tmp_path):
    from herald_personal.project_sync import SyncFailure, fetch_prs

    cfg = config(tmp_path)
    with patch(
        "herald_personal.project_sync.subprocess.run",
        return_value=subprocess.CompletedProcess([], 0, "[]", ""),
    ) as run:
        assert fetch_prs(cfg) == []
        assert run.call_args.args[0][0] == "/opt/bin/gh"
        assert run.call_args.kwargs["timeout"] <= 30
        assert "shell" not in run.call_args.kwargs
    for error in (FileNotFoundError("SECRET"), subprocess.TimeoutExpired("gh", 30)):
        with (
            patch("herald_personal.project_sync.subprocess.run", side_effect=error),
            pytest.raises(SyncFailure, match="github_unavailable"),
        ):
            fetch_prs(cfg)
    with (
        patch(
            "herald_personal.project_sync.subprocess.run",
            return_value=subprocess.CompletedProcess([], 1, "[]", "SECRET"),
        ),
        pytest.raises(SyncFailure, match="github_unavailable"),
    ):
        fetch_prs(cfg)


def test_config_rejects_shell_binary_lookup_and_credential_bearing_url(tmp_path):
    from pydantic import ValidationError

    from herald_personal.project_sync import SyncConfig

    cfg = config(tmp_path).model_dump()
    for change in (
        {"gh_path": "gh"},
        {"status_url": "https://user:secret@example.com/status"},
        {"repository": "example/repo;echo"},
    ):
        with pytest.raises(ValidationError):
            SyncConfig.model_validate(cfg | change)


def test_sync_reports_failure_and_does_not_erase_previous_tasks(tmp_path):
    from herald_personal.project_sync import SyncFailure, collect_snapshot

    with patch(
        "herald_personal.project_sync.fetch_status", side_effect=SyncFailure("source_unavailable")
    ):
        result = collect_snapshot(config(tmp_path))
    assert result.error == "source_unavailable"
    assert result.items == []
    assert "SECRET" not in json.dumps(result.model_dump(mode="json"))


def test_http_feed_is_bounded_and_never_follows_credential_redirects(tmp_path):
    from herald_personal.project_sync import SyncFailure, fetch_status

    actual_client = httpx.Client
    cfg = config(tmp_path)
    visited = []
    for response, error in [
        (httpx.Response(200, json={"runs": []}), None),
        (httpx.Response(302, headers={"Location": "https://evil.test"}), "source_unavailable"),
        (httpx.Response(200, content=b"x" * 1_000_001), "source_invalid"),
        (httpx.Response(200, json={"runs": "bad"}), "source_invalid"),
        (httpx.Response(200, content=b"<html>"), "source_invalid"),
    ]:

        def factory(response=response, **kwargs):
            assert kwargs["follow_redirects"] is False
            assert kwargs["trust_env"] is False

            def respond(request):
                visited.append(str(request.url))
                return response

            return actual_client(transport=httpx.MockTransport(respond), **kwargs)

        with patch("herald_personal.project_sync.httpx.Client", side_effect=factory):
            if error:
                with pytest.raises(SyncFailure, match=error):
                    fetch_status(cfg)
            else:
                assert fetch_status(cfg) == {"runs": []}
    assert visited == [cfg.status_url] * 5
    cfg = cfg.model_copy(update={"status_password_file": tmp_path / "missing"})
    with pytest.raises(SyncFailure, match="source_unavailable"):
        fetch_status(cfg)


def test_private_configuration_and_loopback_only_publishing(tmp_path):
    from herald_personal.models import utc_now
    from herald_personal.project_sync import SyncFailure, private_json, publish
    from herald_personal.projects import ProjectSnapshot

    cfg = config(tmp_path)
    token = tmp_path / "token"
    token.write_text("synthetic-local-token")
    token.chmod(0o600)
    connection = {"url": "http://127.0.0.1:8799", "tokenFile": str(token)}
    cfg.connection_file.write_text(json.dumps(connection))
    cfg.connection_file.chmod(0o644)
    with pytest.raises(SyncFailure, match="configuration_invalid"):
        private_json(cfg.connection_file)
    cfg.connection_file.chmod(0o600)
    body = ProjectSnapshot(project=cfg.project, label=cfg.label, attempted_at=utc_now())
    requests = []
    actual_client = httpx.Client

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"accepted": True})

    with patch(
        "herald_personal.project_sync.httpx.Client",
        side_effect=lambda **kwargs: actual_client(
            transport=httpx.MockTransport(respond), **kwargs
        ),
    ):
        publish(cfg, body)
    assert len(requests) == 1
    assert requests[0].method == "PUT"
    assert requests[0].url.path == "/v1/project-sources/fixture-build"
    assert json.loads(requests[0].content)["project"] == "Fixture Campo"
    cfg.connection_file.write_text(json.dumps(connection | {"url": "https://evil.test"}))
    with pytest.raises(SyncFailure, match="herald_unavailable"):
        publish(cfg, body)
    cfg.connection_file.write_text("[]")
    with pytest.raises(SyncFailure, match="configuration_invalid"):
        private_json(cfg.connection_file)


def test_collect_success_partial_invalid_feed_and_cli_result(tmp_path, capsys):
    from herald_personal.project_sync import SyncFailure, collect_snapshot, main

    cfg = config(tmp_path)
    feed = {"generado": "2026-10-10T14:00:00Z", "runs": [{"id": "n4", "status": "done"}]}
    with (
        patch("herald_personal.project_sync.fetch_status", return_value=feed),
        patch("herald_personal.project_sync.fetch_prs", return_value=[]),
    ):
        result = collect_snapshot(cfg)
    assert result.error is None
    with (
        patch("herald_personal.project_sync.fetch_status", return_value=feed),
        patch(
            "herald_personal.project_sync.fetch_prs", side_effect=SyncFailure("github_unavailable")
        ),
    ):
        assert collect_snapshot(cfg).github_error is True
    with (
        patch("herald_personal.project_sync.fetch_status", return_value={"runs": ["bad"]}),
        patch("herald_personal.project_sync.fetch_prs", return_value=[]),
    ):
        assert collect_snapshot(cfg).error == "source_invalid"
    file = tmp_path / "config.json"
    file.write_text(cfg.model_dump_json())
    file.chmod(0o600)
    with (
        patch("sys.argv", ["project_sync", str(file)]),
        patch("herald_personal.project_sync.collect_snapshot", return_value=result),
        patch("herald_personal.project_sync.publish") as save,
    ):
        assert main() == 0
        save.assert_called_once()
    assert json.loads(capsys.readouterr().out)["items"] == 1
    with patch("sys.argv", ["project_sync"]):
        assert main() == 1
    assert json.loads(capsys.readouterr().out) == {"error": "configuration_required"}
