"""New coordinator surfaces remain scoped to read/query/capture and local plans."""

import unittest
from unittest import mock

from herald_hermes.bridge import Bridge, BridgeError, tool_definitions


class PlanningBridgeTests(unittest.TestCase):
    def setUp(self):
        self.client = mock.Mock()
        self.bridge = Bridge(self.client)

    def test_new_read_surfaces_do_not_expose_model_or_open_claims(self):
        names = {d["name"] for d in tool_definitions()}
        self.assertTrue(
            {
                "mail_workspace_status",
                "mail_workspace_query",
                "mail_workspace_capture",
                "personal_daily_plan_generate",
                "personal_daily_plan_list",
                "coding_observed_sessions",
            }
            <= names
        )
        self.assertFalse(any("claim" in n or "recommendation" in n for n in names))
        self.bridge.call("coding_observed_sessions", {})
        self.client.request.assert_called_with("GET", "/v1/agent-observations")

    def test_mail_query_has_action_allowlist_and_no_extra_arguments(self):
        self.bridge.call(
            "mail_workspace_query",
            {
                "action": "mail-list-items",
                "params": {"texto": "pendientes", "limite": 25},
            },
        )
        self.client.request.assert_called_with(
            "POST",
            "/v1/mail-workspace/query",
            {
                "action": "mail-list-items",
                "params": {"texto": "pendientes", "limite": 25},
            },
        )
        for args in (
            {"action": "mail-delete-item"},
            {"action": "mail-get-item", "params": {"url": "https://external"}},
            {"action": "mail-list-items", "params": {"limite": 101}},
        ):
            with self.assertRaises(BridgeError):
                self.bridge.call("mail_workspace_query", args)

    def test_mail_capture_preserves_canonical_mail_key(self):
        self.bridge.call(
            "mail_workspace_capture", {"clave": "MAIL-123", "priority": "high"}
        )
        self.client.request.assert_called_with(
            "POST",
            "/v1/mail-workspace/tasks",
            {"clave": "MAIL-123", "priority": "high"},
        )
        with self.assertRaises(BridgeError):
            self.bridge.call("mail_workspace_capture", {"clave": "../../123"})

    def test_plan_generation_and_list_use_canonical_api(self):
        self.bridge.call("personal_daily_plan_generate", {"date": "2026-10-08"})
        self.client.request.assert_called_with(
            "POST", "/v1/daily-plans/generate", {"date": "2026-10-08"}
        )
        self.bridge.call("personal_daily_plan_list", {"date": "2026-10-08"})
        self.client.request.assert_called_with("GET", "/v1/daily-plans?date=2026-10-08")

    def test_coder_role_cannot_read_mail_or_generate_personal_plan(self):
        coder = Bridge(self.client, role="coder")
        for name in (
            "mail_workspace_status",
            "mail_workspace_query",
            "mail_workspace_capture",
            "personal_daily_plan_generate",
        ):
            with self.assertRaises(BridgeError):
                coder.call(name, {})


if __name__ == "__main__":
    unittest.main()
