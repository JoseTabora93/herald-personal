"""Hermes reads the exact same project evidence as the native dashboard."""

import unittest
from unittest.mock import Mock

from herald_hermes.bridge import Bridge, tool_definitions


class ProjectsTests(unittest.TestCase):
    def test_read_projects_is_shared_and_readonly(self):
        client = Mock()
        client.request.return_value = {"items": [{"id": "fixture-project"}]}
        result = Bridge(client).call("personal_project_list", {})
        self.assertEqual(result["items"][0]["id"], "fixture-project")
        client.request.assert_called_once_with("GET", "/v1/projects")
        definition = next(t for t in tool_definitions() if t["name"] == "personal_project_list")
        self.assertTrue(definition["annotations"]["readOnlyHint"])
