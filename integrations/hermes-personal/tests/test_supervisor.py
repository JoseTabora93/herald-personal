"""Real child process tests using local fake CLIs, never live coding agents."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from herald_hermes.supervisor import Supervisor, SupervisorError, build_command


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.workspace = self.root / "repo"
        self.workspace.mkdir()
        self.fake = self.root / "fake-agent"
        self.fake.write_text(
            f"#!{sys.executable}\n"
            + """import json, os, sys, time
prompt = sys.stdin.read() if '-p' in sys.argv else sys.argv[-1]
if 'slow' in prompt:
    time.sleep(10)
if 'fail' in prompt:
    print(json.dumps({'type': 'result', 'is_error': True, 'result': 'fixture failure'}))
    sys.exit(2)
if 'noise' in prompt:
    print('not json')
    sys.exit(0)
if 'secret' in prompt:
    print(json.dumps({'type':'result','result':os.environ.get('ANTHROPIC_API_KEY')}))
    sys.exit(0)
if 'flood' in prompt:
    print('x' * 1100000)
    sys.exit(0)
print(json.dumps({'type': 'result', 'is_error': False, 'result': 'fixture only', 'cwd': os.getcwd(), 'personal_token_inherited': 'HERALD_PERSONAL_TOKEN' in os.environ}))
"""
        )
        self.fake.chmod(0o700)
        self.config = self.root / "operator.json"
        self.document = {
            "version": 1,
            "state_dir": str(self.root / "state"),
            "max_deadline_seconds": 5,
            "max_attempts": 2,
            "workspaces": {
                "fixture": {
                    "path": str(self.workspace),
                    "agents": ["claude", "opencode"],
                }
            },
            "agents": {
                "claude": {"executable": str(self.fake)},
                "opencode": {"executable": str(self.fake)},
            },
            "scopes": {
                "success": {
                    "workspace": "fixture",
                    "agent": "claude",
                    "prompt": "Summarize fixture",
                    "deadline_seconds": 3,
                    "max_attempts": 1,
                },
                "slow": {
                    "workspace": "fixture",
                    "agent": "opencode",
                    "prompt": "slow",
                    "deadline_seconds": 1,
                    "max_attempts": 1,
                },
                "fail": {
                    "workspace": "fixture",
                    "agent": "claude",
                    "prompt": "fail",
                    "deadline_seconds": 3,
                    "max_attempts": 2,
                },
            },
        }
        self.save_config()
        self.supervisor = Supervisor(self.config)

    def save_config(self):
        self.config.write_text(json.dumps(self.document))
        self.config.chmod(0o600)

    def tearDown(self):
        for run in self.supervisor.list_runs():
            if run["status"] in {"queued", "running", "cancel_requested"}:
                self.supervisor.cancel(run["run_id"])
                self.finish(run["run_id"])
        self.tmp.cleanup()

    def finish(self, run_id, timeout=8):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            result = self.supervisor.status(run_id)
            if result["status"] in {
                "completed",
                "failed",
                "timed_out",
                "cancelled",
                "interrupted",
            }:
                return result
            time.sleep(0.04)
        self.fail("supervised fixture exceeded test deadline")

    def test_stable_run_id_replay_and_durable_evidence_after_restart(self):
        with mock.patch.dict(os.environ, {"HERALD_PERSONAL_TOKEN": "must-not-inherit"}):
            run = self.supervisor.start("success", "request-1")
        replay = self.supervisor.start("success", "request-1")
        self.assertEqual(run["run_id"], replay["run_id"])
        done = self.finish(run["run_id"])
        self.assertEqual(done["status"], "completed")
        self.assertEqual(done["verification"], "not_run")
        self.assertFalse(done["attempts"][0]["result"]["personal_token_inherited"])
        restarted = Supervisor(self.config)
        self.assertEqual(restarted.status(run["run_id"])["attempts"], done["attempts"])
        self.assertTrue(done["attempts"][0]["stdout_sha256"])
        with self.assertRaises(SupervisorError):
            self.supervisor.start("fail", "request-1")

    def test_unknown_scope_and_untrusted_path_cannot_execute(self):
        with self.assertRaises(SupervisorError):
            self.supervisor.start("../../arbitrary", "request-2")
        self.document["workspaces"]["fixture"]["path"] = str(self.root / "absent")
        self.save_config()
        with self.assertRaises(SupervisorError):
            Supervisor(self.config)

    def test_scope_must_be_outside_agent_writable_workspace(self):
        nested = self.workspace / "operator.json"
        nested.write_text(json.dumps(self.document))
        nested.chmod(0o600)
        with self.assertRaises(SupervisorError):
            Supervisor(nested)

    def test_deadline_and_cancel_do_not_kill_an_unrelated_process(self):
        unrelated = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(20)"]
        )
        try:
            run = self.supervisor.start("slow", "deadline")
            done = self.finish(run["run_id"])
            self.assertEqual(done["status"], "timed_out")
            run = self.supervisor.start("slow", "cancel")
            self.supervisor.cancel(run["run_id"])
            self.assertEqual(self.finish(run["run_id"])["status"], "cancelled")
            self.assertIsNone(unrelated.poll())
        finally:
            unrelated.terminate()
            unrelated.wait()

    def test_retry_is_explicit_and_bounded(self):
        run = self.supervisor.start("fail", "failed-run")
        done = self.finish(run["run_id"])
        self.assertEqual(len(done["attempts"]), 1)
        self.supervisor.retry(run["run_id"], confirmed=True)
        done = self.finish(run["run_id"])
        self.assertEqual(len(done["attempts"]), 2)
        with self.assertRaises(SupervisorError):
            self.supervisor.retry(run["run_id"], confirmed=True)

    def test_agent_argv_has_no_permission_bypass_or_shell_interpolation(self):
        scope = dict(
            self.document["scopes"]["success"], prompt="$(touch /tmp/should-not-exist)"
        )
        argv, stdin, env = build_command(
            "claude", self.document["agents"]["claude"], scope, "fake-session"
        )
        self.assertIn("json", argv)
        self.assertIn("manual", argv)
        self.assertNotIn("--dangerously-skip-permissions", argv)
        self.assertEqual(stdin, scope["prompt"])
        argv, stdin, env = build_command(
            "opencode", self.document["agents"]["opencode"], scope, "fake-session"
        )
        self.assertIn("json", argv)
        self.assertEqual(argv[-1], scope["prompt"])
        self.assertNotIn("HERALD_PERSONAL_TOKEN", env)

    def test_relative_state_or_mutable_operator_config_is_rejected(self):
        self.document["state_dir"] = "relative-state"
        self.save_config()
        with self.assertRaises(SupervisorError):
            Supervisor(self.config)

    def test_two_scopes_cannot_mutate_one_workspace_concurrently(self):
        first = self.supervisor.start("slow", "first-run")
        with self.assertRaises(SupervisorError):
            self.supervisor.start("success", "second-run")
        self.supervisor.cancel(first["run_id"])

    def test_process_output_and_exit_are_evidence_not_test_success(self):
        for prompt, outcome in [("noise", "failed"), ("flood", "output_limit")]:
            self.document["scopes"][prompt] = dict(
                self.document["scopes"]["success"], prompt=prompt
            )
        self.save_config()
        self.supervisor = Supervisor(self.config)
        for prompt, outcome in [("noise", "failed"), ("flood", "output_limit")]:
            run = self.supervisor.start(prompt, prompt)
            done = self.finish(run["run_id"])
            self.assertEqual(done["status"], "failed")
            self.assertEqual(done["attempts"][0]["outcome"], outcome)
            self.assertEqual(done["verification"], "not_run")

    def test_secret_output_is_redacted_and_projection_contains_no_result(self):
        self.document["agents"]["claude"]["credential_env"] = ["ANTHROPIC_API_KEY"]
        self.document["scopes"]["secret"] = dict(
            self.document["scopes"]["success"], prompt="secret"
        )
        self.save_config()
        self.supervisor = Supervisor(self.config)
        with mock.patch.dict(
            os.environ, {"ANTHROPIC_API_KEY": "fixture-secret-do-not-persist"}
        ):
            run = self.supervisor.start("secret", "redaction")
            done = self.finish(run["run_id"])
        self.assertEqual(done["attempts"][0]["result"]["result"], "[REDACTED]")
        projected = self.supervisor.projection(done)
        self.assertNotIn("result", projected["attempts"][0])
        self.assertNotIn("prompt", projected)
        self.assertNotIn(
            "fixture-secret-do-not-persist",
            self.supervisor._path(run["run_id"]).read_text(),
        )

    def test_operator_scope_revocation_before_worker_start_is_effective(self):
        with mock.patch.object(self.supervisor, "_spawn"):
            run = self.supervisor.start("success", "revoked")
        self.document["scopes"]["success"]["prompt"] = "Changed by operator"
        self.save_config()
        Supervisor(self.config).work(run["run_id"], run["generation"])
        done = self.supervisor.status(run["run_id"])
        self.assertEqual(done["status"], "failed")
        self.assertEqual(done["attempts"], [])

    def test_stale_worker_is_marked_interrupted_without_pid_signal_or_retry(self):
        with mock.patch.object(self.supervisor, "_spawn"):
            run = self.supervisor.start("success", "stale")
        run["updated_at"] = "2000-01-01T00:00:00Z"
        self.supervisor._path(run["run_id"]).write_text(json.dumps(run))
        with mock.patch("herald_hermes.supervisor.os.killpg") as signal_process:
            self.assertEqual(
                self.supervisor.status(run["run_id"])["status"], "interrupted"
            )
            signal_process.assert_not_called()
        with self.assertRaises(SupervisorError):
            self.supervisor.retry(run["run_id"], confirmed=True)

    def test_confirmation_and_operator_limits_are_not_optional(self):
        with self.assertRaises(SupervisorError):
            self.supervisor.retry("not-a-uuid", confirmed=False)
        with self.assertRaises(SupervisorError):
            self.supervisor.status("../../etc/passwd")
        self.document["scopes"]["success"]["deadline_seconds"] = 99999
        self.save_config()
        with self.assertRaises(SupervisorError):
            Supervisor(self.config)

    def test_retry_obeys_same_workspace_concurrency_limit(self):
        failed = self.supervisor.start("fail", "failed-before-other-run")
        self.finish(failed["run_id"])
        active = self.supervisor.start("slow", "active-during-retry")
        with self.assertRaises(SupervisorError):
            self.supervisor.retry(failed["run_id"], confirmed=True)
        self.supervisor.cancel(active["run_id"])


if __name__ == "__main__":
    unittest.main()
