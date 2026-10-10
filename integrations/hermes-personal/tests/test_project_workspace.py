"""Project guidance uses the same durable API as the desktop."""

import unittest
from unittest.mock import Mock

from herald_hermes.bridge import Bridge, BridgeError


class WorkspaceToolsTests(unittest.TestCase):
    def test_read_context_and_record_direction_have_distinct_authority(self):
        client = Mock()
        bridge = Bridge(client)
        pid = "a" * 24
        bridge.call("personal_project_context", {"project_id": pid})
        client.request.assert_called_with("GET", f"/v1/projects/{pid}/workspace")
        args = {"project_id": pid, "text": "Primero CLI", "expected_revision": 0}
        bridge.call("personal_project_direction_update", args)
        client.request.assert_called_with("PUT", f"/v1/projects/{pid}/direction", {"text": "Primero CLI", "expected_revision": 0})
        with self.assertRaises(BridgeError):
            bridge.call("personal_project_context", {"project_id": "../bad"})
