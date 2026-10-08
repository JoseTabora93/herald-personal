"""Public CLI integration, with no access to any Hermes database."""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from herald_hermes.kanban import KanbanClient, KanbanError


class KanbanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.client = KanbanClient(
            "/usr/bin/true", Path(self.tmp.name), "personal", allow_create=True
        )

    def tearDown(self):
        self.tmp.cleanup()

    @mock.patch("herald_hermes.kanban.subprocess.run")
    def test_read_uses_supported_cli_and_explicit_isolated_home(self, run):
        run.return_value = mock.Mock(returncode=0, stdout='{"id":"task-1"}', stderr="")
        result = self.client.show("task-1")
        self.assertEqual(result["id"], "task-1")
        self.assertEqual(
            run.call_args.args[0],
            [
                "/usr/bin/true",
                "kanban",
                "--board",
                "personal",
                "show",
                "task-1",
                "--json",
            ],
        )
        self.assertEqual(
            run.call_args.kwargs["env"]["HERMES_HOME"],
            str(Path(self.tmp.name).resolve()),
        )
        self.assertFalse(run.call_args.kwargs.get("shell", False))

    @mock.patch("herald_hermes.kanban.subprocess.run")
    def test_created_card_is_blocked_idempotent_and_never_assigned(self, run):
        run.return_value = mock.Mock(returncode=0, stdout='{"id":"task-1"}', stderr="")
        self.client.create("Revisar resultado", "herald-run-id", confirmed=True)
        argv = run.call_args.args[0]
        self.assertIn("--idempotency-key", argv)
        self.assertEqual(argv[argv.index("--initial-status") + 1], "blocked")
        self.assertNotIn("--assignee", argv)
        self.assertNotIn("dispatch", argv)
        with self.assertRaises(KanbanError):
            self.client.create("No confirmado", "x", confirmed=False)

    def test_global_home_and_flag_injection_rejected(self):
        with self.assertRaises(KanbanError):
            KanbanClient("/usr/bin/true", Path.home() / ".hermes", "personal")
        with self.assertRaises(KanbanError):
            self.client.show("--all")


if __name__ == "__main__":
    unittest.main()
