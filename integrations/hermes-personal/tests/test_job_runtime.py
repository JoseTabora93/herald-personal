"""Real local process bounds and command/envelope isolation, never live models."""

import io
import json
import os
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from herald_hermes.daily_jobs import (
    HermesRecommender,
    JobError,
    load_job_config,
    parse_hermes_result,
)
from herald_hermes.daily_jobs import (
    main as daily_main,
)
from herald_hermes.observer import (
    ObservationError,
    OpenCodeReader,
    collect_opencode,
    poll,
)
from herald_hermes.runtime import RuntimeErrorSafe, bounded_run


class JobRuntimeTests(unittest.TestCase):
    def test_timeout_cleans_owned_descendant_after_command_leader_exits(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            ready, ended = root / "ready", root / "ended"
            child = (
                "import os,signal,time;from pathlib import Path;"
                f"signal.signal(signal.SIGTERM,lambda *_: (Path({str(ended)!r}).touch(),exit(0)));"
                f"Path({str(ready)!r}).write_text(str(os.getpgrp()));"
                "time.sleep(30)"
            )
            leader = (
                "import subprocess,sys,time;from pathlib import Path;"
                f"subprocess.Popen([sys.executable,'-c',{child!r}]);"
                f"\nwhile not Path({str(ready)!r}).exists(): time.sleep(0.01)"
            )
            try:
                with self.assertRaises(TimeoutError):
                    bounded_run([sys.executable, "-c", leader], timeout=0.4)
                until = time.monotonic() + 0.5
                while not ended.exists() and time.monotonic() < until:
                    time.sleep(0.01)
                self.assertTrue(
                    ended.exists(), "The owned descendant survived the deadline"
                )
            finally:
                if ready.exists():
                    try:
                        os.killpg(int(ready.read_text()), signal.SIGTERM)
                    except ProcessLookupError:
                        pass

    def test_subprocess_timeout_and_output_limit_are_enforced(self):
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            bounded_run(
                [sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.2
            )
        self.assertLess(time.monotonic() - started, 2)
        with self.assertRaises(RuntimeErrorSafe):
            bounded_run([sys.executable, "-c", "print('x'*100000)"], maximum=1000)

    def test_subprocess_environment_does_not_export_personal_credentials(self):
        with mock.patch.dict(
            os.environ,
            {"HERALD_PERSONAL_TOKEN": "private", "OPENAI_API_KEY": "private"},
        ):
            result = bounded_run(
                [
                    sys.executable,
                    "-c",
                    "import os,json;print(json.dumps([os.getenv('HERALD_PERSONAL_TOKEN'),os.getenv('OPENAI_API_KEY')]))",
                ]
            )
        self.assertEqual(json.loads(result), [None, None])

    def test_stdin_is_literal_and_does_not_appear_in_argv(self):
        text = "$(echo private) `command`"
        result = bounded_run(
            [sys.executable, "-c", "import sys;print(sys.stdin.read())"],
            input_text=text,
        )
        self.assertEqual(result.strip(), text)

    def test_only_terminal_hermes_result_is_accepted(self):
        payload = {"summary": "uno", "recommendations": []}
        good = json.dumps(
            {"type": "result", "exit_code": 0, "text": json.dumps(payload)}
        )
        self.assertEqual(
            parse_hermes_result(
                json.dumps({"type": "text", "text": "IGNORE"}) + "\n" + good
            ),
            payload,
        )
        for raw in (
            good + "\n" + good,
            json.dumps(payload),
            json.dumps({"type": "result", "exit_code": 1, "text": "private"}),
            json.dumps({"type": "tool_use", "name": "terminal"}) + "\n" + good,
        ):
            with self.assertRaises(JobError):
                parse_hermes_result(raw)

    def test_model_command_is_pinned_bounded_and_does_not_resume_a_session(self):
        value = {
            "summary": "base",
            "recommendations": [
                {
                    "title": "Revisar",
                    "reason": "Fuente parcial",
                    "evidence_refs": ["mail-workspace"],
                }
            ],
        }
        run = mock.Mock(
            return_value=json.dumps(
                {"type": "result", "exit_code": 0, "text": json.dumps(value)}
            )
        )
        model = HermesRecommender("/trusted/hermes", "/private/hermes-home", run=run)
        model(
            {
                "sources": [{"id": "mail-workspace", "status": "stale"}],
                "mail_summary": {"total": 3},
            }
        )
        argv = run.call_args.args[0]
        self.assertEqual(argv[argv.index("--toolsets") + 1], "todo")
        self.assertEqual(argv[argv.index("--query-file") + 1], "-")
        self.assertNotIn("--resume", argv)
        self.assertNotIn("--yolo", argv)
        self.assertLessEqual(run.call_args.kwargs["timeout"], 60)

    def test_job_home_and_timezone_must_match_owner(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            home = root / "hermes-home"
            home.mkdir()
            file = root / "jobs.json"
            config = {
                "owner": "herald-personal",
                "timezone": "America/Tegucigalpa",
                "hermes_home": str(home),
                "personal_token_file": str(root / "token"),
            }
            file.write_text(json.dumps(config))
            file.chmod(0o600)
            with mock.patch.dict(os.environ, {"HERMES_HOME": str(home)}):
                self.assertEqual(
                    load_job_config(file)["timezone"], "America/Tegucigalpa"
                )
            with (
                mock.patch.dict(os.environ, {"HERMES_HOME": str(root / "other")}),
                self.assertRaises(JobError),
            ):
                load_job_config(file)
            config["timezone"] = "UTC"
            file.write_text(json.dumps(config))
            with self.assertRaises(JobError):
                load_job_config(file)

    def test_opencode_never_requests_pending_details_outside_workspace_allowlist(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sessions = {
                "data": [
                    {"id": "ses_in", "location": {"directory": str(root)}},
                    {
                        "id": "ses_out",
                        "location": {"directory": "/different/private/work"},
                    },
                ]
            }
            reader = mock.Mock()

            def get(path):
                if path == "/api/session?limit=50":
                    return sessions
                if path == "/api/session/active":
                    return {
                        "data": {
                            "ses_in": {"type": "running"},
                            "ses_out": {"type": "running"},
                        }
                    }
                return {"data": []}

            reader.get.side_effect = get
            with mock.patch(
                "herald_hermes.observer.OpenCodeReader", return_value=reader
            ):
                collect_opencode(
                    "/private/service.json",
                    {"work": str(root)},
                    "2026-10-08T23:30:00+00:00",
                )
            self.assertFalse(
                any("ses_out" in str(call) for call in reader.get.call_args_list)
            )

    def test_opencode_total_poll_budget_cannot_grow_with_session_count(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder) / "service.json"
            state.write_text(
                json.dumps({"url": "http://127.0.0.1:49374", "password": "private"})
            )
            state.chmod(0o600)
            reader = OpenCodeReader(state, budget_seconds=0.01)
            time.sleep(0.02)
            with self.assertRaises(ObservationError):
                reader.get("/api/session/active")

    def test_reader_accepts_only_bounded_json_and_redacts_upstream_failures(self):
        import urllib.error

        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder) / "service.json"
            state.write_text(
                json.dumps({"url": "http://127.0.0.1:49374", "password": "private"})
            )
            state.chmod(0o600)
            reader = OpenCodeReader(state)
            response = mock.MagicMock()
            response.__enter__.return_value = response
            response.headers = {"Content-Type": "application/json"}
            response.read.return_value = b'{"data":{}}'
            reader._opener = mock.Mock()
            reader._opener.open.return_value = response
            self.assertEqual(reader.get("/api/session/active"), {"data": {}})
            request = reader._opener.open.call_args.args[0]
            self.assertEqual(request.get_method(), "GET")
            self.assertTrue(request.get_header("Authorization").startswith("Basic "))
            for kind, raw in (
                ("text/html", b"<html>"),
                ("application/json", b"x" * 524289),
                ("application/json", b"bad"),
                ("application/json", b"[]"),
            ):
                response.headers = {"Content-Type": kind}
                response.read.return_value = raw
                with self.assertRaises(ObservationError):
                    reader.get("/api/session/active")
            reader._opener.open.side_effect = urllib.error.HTTPError(
                "http://127.0.0.1", 401, "PRIVATE", {}, io.BytesIO(b"PRIVATE")
            )
            with self.assertRaises(ObservationError) as caught:
                reader.get("/api/session/active")
            self.assertNotIn("PRIVATE", str(caught.exception))

    def test_recent_page_omission_fetches_active_metadata_and_signal_failure_is_explicit(
        self,
    ):
        with tempfile.TemporaryDirectory() as folder:
            reader = mock.Mock()

            def get(path):
                if path == "/api/session?limit=50":
                    return {"data": []}
                if path == "/api/session/active":
                    return {"data": {"ses_new": {"type": "running"}}}
                if path == "/api/session/ses_new":
                    return {
                        "data": {"id": "ses_new", "location": {"directory": folder}}
                    }
                raise ObservationError("Signal unsupported")

            reader.get.side_effect = get
            with mock.patch(
                "herald_hermes.observer.OpenCodeReader", return_value=reader
            ):
                rows = collect_opencode(
                    "/private/service.json",
                    {"work": folder},
                    "2026-10-08T23:30:00+00:00",
                )
            self.assertEqual(rows[0]["status"], "active")
            self.assertIn("permission_signal_unavailable", rows[0]["signals"])
            self.assertIn("question_signal_unavailable", rows[0]["signals"])

    def test_poll_partial_provider_failure_preserves_other_provider(self):
        with tempfile.TemporaryDirectory() as folder:
            config = {
                "claude_executable": "/trusted/claude",
                "opencode_service_file": "/private/service.json",
                "workspaces": {"work": folder},
            }
            with (
                mock.patch(
                    "herald_hermes.observer.collect_claude",
                    side_effect=ObservationError("secret"),
                ),
                mock.patch(
                    "herald_hermes.observer.collect_opencode",
                    return_value=[{"observer_id": "one"}],
                ),
                mock.patch(
                    "herald_hermes.observer.publish_observations", return_value=[{}]
                ) as publish,
            ):
                result = poll(config, mock.Mock())
            self.assertEqual(
                result,
                {
                    "observed": 1,
                    "errors": ["claude_unavailable"],
                    "verification": "not_run",
                },
            )
            self.assertEqual(publish.call_args.args[1], [{"observer_id": "one"}])
            with self.assertRaises(ObservationError):
                poll({}, mock.Mock())

    def test_daily_cli_uses_private_owner_config_and_can_validate_without_opening(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            home = root / "home"
            home.mkdir()
            file = root / "jobs.json"
            file.write_text(
                json.dumps(
                    {
                        "owner": "herald-personal",
                        "timezone": "America/Tegucigalpa",
                        "hermes_home": str(home),
                        "personal_token_file": str(root / "token"),
                        "app_path": "/Applications/Herald Personal.app",
                    }
                )
            )
            file.chmod(0o600)
            client = mock.Mock()
            client.request.side_effect = [
                {"date": "2026-10-08", "revision": 1, "model_error": "not_configured"}
            ]
            output = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"HERMES_HOME": str(home)}),
                mock.patch(
                    "herald_hermes.daily_jobs.PersonalClient.from_env",
                    return_value=client,
                ),
                mock.patch("sys.stdout", output),
            ):
                daily_main(
                    [
                        "daily",
                        "--config",
                        str(file),
                        "--date",
                        "2026-10-08",
                        "--no-open",
                    ]
                )
            self.assertFalse(json.loads(output.getvalue())["opened"])
            self.assertEqual(client.request.call_count, 1)


if __name__ == "__main__":
    unittest.main()
