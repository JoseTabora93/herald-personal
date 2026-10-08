"""Real MCP SDK client/server stdio handshake against a loopback API fixture."""

import json
import os
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from test_bridge import Handler


class MCPTransportTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()

    async def test_stdio_initialization_tool_discovery_and_api_roundtrip(self):
        env = {
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
            "HERALD_PERSONAL_URL": f"http://127.0.0.1:{self.http.server_port}",
            "HERALD_PERSONAL_TOKEN": "fixture-mcp-token",
        }
        env.update(
            {
                key: value
                for key, value in os.environ.items()
                if key.startswith("COVERAGE_")
            }
        )
        params = StdioServerParameters(
            command=sys.executable, args=["-m", "herald_hermes"], env=env
        )
        async with (
            stdio_client(params) as (read, write),
            ClientSession(read, write) as client,
        ):
            info = await client.initialize()
            self.assertEqual(info.serverInfo.name, "herald-personal")
            catalog = await client.list_tools()
            names = {tool.name for tool in catalog.tools}
            self.assertIn("personal_mail_to_task", names)
            self.assertNotIn("coding_run_start", names)
            captured = await client.call_tool(
                "personal_task_create",
                {"title": "MCP fixture", "idempotency_key": "mcp-1"},
            )
            self.assertFalse(captured.isError)
            self.assertEqual(
                json.loads(captured.content[0].text)["id"], "task-from-api"
            )
            denied = await client.call_tool(
                "personal_mail_archive", {"thread_id": "m1", "confirmed": True}
            )
            self.assertTrue(denied.isError)
            self.assertNotIn("fixture-mcp-token", denied.content[0].text)


if __name__ == "__main__":
    unittest.main()
