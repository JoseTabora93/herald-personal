"""Public session metadata is evidence, never permission to control a session."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from herald_hermes.observer import (
    ObservationError,
    OpenCodeReader,
    collect_claude,
    parse_claude_sessions,
    parse_opencode_sessions,
    publish_observations,
)

NOW = "2026-10-08T23:30:00.000000+00:00"
SESSION = "a1558e9e-fa12-4dff-b719-5ea8f6f18a36"


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.workspace = self.root / "work"
        self.workspace.mkdir()
        self.scopes = {"work": str(self.workspace)}

    def claude(self, **changes):
        return {
            "pid": 91309,
            "cwd": str(self.workspace),
            "kind": "interactive",
            "startedAt": 1791311931546,
            "sessionId": SESSION,
            "name": "PRIVATE prompt; do not export",
            "status": "busy",
            **changes,
        }

    def test_claude_public_status_and_privacy(self):
        row = parse_claude_sessions([self.claude()], self.scopes, NOW)[0]
        self.assertEqual((row["status"], row["workspace"]), ("active", "work"))
        self.assertEqual(row["evidence_source"], "claude_agents_cli")
        self.assertEqual(row["verification"], "not_run")
        self.assertNotIn("PRIVATE", json.dumps(row))
        self.assertNotIn(str(self.workspace), json.dumps(row))
        self.assertNotIn("pid", row)
        self.assertEqual(
            row["observer_id"],
            parse_claude_sessions([self.claude()], self.scopes, NOW)[0]["observer_id"],
        )

    def test_process_presence_and_unrecognized_status_are_unknown(self):
        for state in (None, "new-unrecognized-state"):
            self.assertEqual(
                parse_claude_sessions([self.claude(status=state)], self.scopes, NOW)[0][
                    "status"
                ],
                "unknown",
            )

    def test_workspace_boundary_and_symlink_escape(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.workspace / "escape").symlink_to(outside, target_is_directory=True)
        for cwd in (
            str(outside),
            str(self.workspace) + "-other",
            str(self.workspace / "escape"),
        ):
            self.assertEqual(
                parse_claude_sessions([self.claude(cwd=cwd)], self.scopes, NOW), []
            )

    def test_invalid_native_identifier_is_not_published(self):
        self.assertEqual(
            parse_claude_sessions(
                [self.claude(sessionId="../../secret")], self.scopes, NOW
            ),
            [],
        )

    def test_claude_uses_only_public_inventory_command_with_deadline(self):
        run = mock.Mock(return_value=json.dumps([self.claude()]))
        collect_claude("/trusted/claude", self.scopes, NOW, run=run)
        self.assertEqual(run.call_args.args[0], ["/trusted/claude", "agents", "--json"])
        self.assertLessEqual(run.call_args.kwargs["timeout"], 10)

    def test_opencode_v2_running_and_permission_precedence(self):
        sessions = {
            "data": [
                {
                    "id": "ses_abc",
                    "location": {"directory": str(self.workspace)},
                    "title": "PRIVATE",
                    "time": {"updated": 1},
                }
            ]
        }
        active = {"data": {"ses_abc": {"type": "running"}}}
        rows = parse_opencode_sessions(
            sessions,
            active,
            {"data": [{"sessionID": "ses_abc", "resources": ["PRIVATE COMMAND"]}]},
            {"data": []},
            self.scopes,
            NOW,
        )
        self.assertEqual(rows[0]["status"], "waiting_permission")
        self.assertNotIn("PRIVATE", json.dumps(rows))
        self.assertEqual(rows[0]["verification"], "not_run")

    def test_opencode_absent_active_is_idle_not_completed_or_test_pass(self):
        sessions = {
            "data": [
                {
                    "id": "ses_abc",
                    "location": {"directory": str(self.workspace)},
                    "outcome": "success",
                }
            ]
        }
        rows = parse_opencode_sessions(
            sessions, {"data": {}}, {"data": []}, None, self.scopes, NOW
        )
        self.assertEqual(rows[0]["status"], "idle")
        self.assertEqual(rows[0]["verification"], "not_run")
        self.assertIn("question_signal_unavailable", rows[0]["signals"])

    def test_missing_active_snapshot_cannot_infer_idle(self):
        sessions = {
            "data": [{"id": "ses_abc", "location": {"directory": str(self.workspace)}}]
        }
        self.assertEqual(
            parse_opencode_sessions(sessions, None, None, None, self.scopes, NOW)[0][
                "status"
            ],
            "unknown",
        )

    def test_opencode_credentials_loopback_private_and_no_control_routes(self):
        state = self.root / "service.json"
        state.write_text(
            json.dumps(
                {"url": "http://127.0.0.1:49374", "password": "private", "pid": 36042}
            )
        )
        state.chmod(0o600)
        reader = OpenCodeReader(state)
        for path in (
            "/api/session/ses_abc/prompt",
            "/api/credential",
            "http://example.com",
            "/api/session/../credential",
        ):
            with self.assertRaises(ObservationError):
                reader.get(path)
        state.chmod(0o644)
        with self.assertRaises(ObservationError):
            OpenCodeReader(state)
        state.chmod(0o600)
        state.write_text(
            json.dumps({"url": "http://example.com", "password": "private"})
        )
        with self.assertRaises(ObservationError):
            OpenCodeReader(state)

    def test_publication_reads_revision_and_never_completes_tasks(self):
        rows = parse_claude_sessions([self.claude()], self.scopes, NOW)
        client = mock.Mock()
        client.request.side_effect = [
            {"items": [{**rows[0], "revision": 7}]},
            {**rows[0], "revision": 8},
        ]
        result = publish_observations(client, rows)
        self.assertEqual(result[0]["revision"], 8)
        method, path, body = client.request.call_args.args
        self.assertEqual(method, "PUT")
        self.assertEqual(path, "/v1/agent-observations/" + rows[0]["observer_id"])
        self.assertEqual(body["revision"], 8)
        self.assertNotIn("/tasks", str(client.mock_calls))


if __name__ == "__main__":
    unittest.main()
