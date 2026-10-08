"""Official MCP Python SDK stdio transport. stdout is reserved for MCP frames."""

import asyncio
import json
import os
import sys

from .bridge import Bridge, BridgeError, PersonalClient
from .kanban import KanbanClient, KanbanError
from .supervisor import Supervisor, SupervisorError


def configured_bridge():
    supervisor = None
    config = os.environ.get("HERALD_CODING_CONFIG")
    if config:
        supervisor = Supervisor(config)
    kanban = None
    home = os.environ.get("HERALD_KANBAN_HOME")
    if home:
        kanban = KanbanClient(
            os.environ.get("HERALD_HERMES_EXECUTABLE", ""),
            home,
            os.environ.get("HERALD_KANBAN_BOARD", "personal"),
            allow_create=os.environ.get("HERALD_KANBAN_ALLOW_CREATE") == "1",
        )
    return Bridge(
        PersonalClient.from_env(),
        allow_draft=os.environ.get("HERALD_PERSONAL_ALLOW_MAIL_DRAFT") == "1",
        allow_archive=os.environ.get("HERALD_PERSONAL_ALLOW_MAIL_ARCHIVE") == "1",
        supervisor=supervisor,
        kanban=kanban,
        role=os.environ.get("HERALD_MCP_ROLE", "personal"),
    )


async def serve():
    from mcp.server.lowlevel import Server
    from mcp.server.stdio import stdio_server
    from mcp.types import CallToolResult, TextContent, Tool

    bridge = configured_bridge()
    server = Server("herald-personal")

    @server.list_tools()
    async def list_tools():
        return [Tool(**definition) for definition in bridge.definitions]

    @server.call_tool()
    async def call_tool(name, arguments):
        try:
            result = await asyncio.to_thread(bridge.call, name, arguments or {})
            return CallToolResult(
                content=[
                    TextContent(
                        type="text", text=json.dumps(result, ensure_ascii=False)
                    )
                ]
            )
        except (BridgeError, SupervisorError, KanbanError) as exc:
            return CallToolResult(
                isError=True, content=[TextContent(type="text", text=str(exc))]
            )
        except Exception:  # noqa: BLE001 -- protocol boundary must not expose arbitrary upstream errors
            return CallToolResult(
                isError=True,
                content=[
                    TextContent(
                        type="text",
                        text="Error interno de integración; revisar configuración.",
                    )
                ],
            )

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream, write_stream, server.create_initialization_options()
        )


def main():
    try:
        asyncio.run(serve())
    except (BridgeError, SupervisorError, KanbanError, OSError, ImportError):
        print(
            "Herald MCP no iniciado: revise token, configuración, rutas y SDK mcp instalado.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
