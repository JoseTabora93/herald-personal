#!/usr/bin/env python3
"""Explicit synthetic-only Electron QA service; never reads operator mail credentials."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import secrets
import sys

ROOT = Path(__file__).resolve().parents[1]
QA = ROOT / ".runtime" / "qa"
sys.path.insert(0, str(ROOT / "services" / "personal"))
sys.path.insert(0, str(ROOT / "integrations" / "hermes-personal" / "src"))


def initialize():
    for directory in (QA, QA / "private", QA / "data", QA / "hermes-home" / "herald-os"):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    token = QA / "private" / "token"
    if not token.exists():
        token.write_text(secrets.token_urlsafe(48))
    token.chmod(0o600)
    prefs = {
        "fullscreenOnLaunch": False,
        "reduceMotion": True,
        "voice": {"enabled": False, "wakeWord": False, "hotkey": ""},
        "continuity": {"enabled": False, "exclude": []},
        "crashHelp": {"enabled": False, "muted": []},
        "spaces": [{"id": "qa", "name": "QA · DATOS SINTÉTICOS", "color": "#4d92ff"}],
        "activeSpace": "qa",
    }
    (QA / "hermes-home" / "herald-os" / "prefs.json").write_text(json.dumps(prefs))
    return token


def graph_fixture(request):
    import httpx

    with (QA / "provider-requests.jsonl").open("a") as stream:
        stream.write(json.dumps({"method": request.method, "path": request.url.path}) + "\n")
    if request.method != "GET" or request.url.host != "graph.microsoft.com" or not request.url.path.endswith("/messages/delta"):
        return httpx.Response(501, json={"error": "QA fixture allows inbox reads only"})
    messages = [
        {
            "id": "qa-provider-message-1",
            "subject": "QA SINTÉTICO · Revisar propuesta de mantenimiento",
            "from": {"emailAddress": {"address": "compras@example.test"}},
            "bodyPreview": "Confirmar alcance y fecha de revisión. Datos sintéticos de QA.",
            "body": {"contentType": "text", "content": "QA · DATOS SINTÉTICOS\n\nConfirmar alcance y fecha de revisión.\n<b>Texto literal de prueba</b>\n\nEsta cuenta existe únicamente en el transporte simulado."},
            "receivedDateTime": "2026-10-08T18:00:00Z",
            "isRead": False,
            "parentFolderId": "qa-inbox",
            "webLink": "https://outlook.office.com/mail/inbox/id/qa-synthetic-message",
            "importance": "high",
        },
        {
            "id": "qa-provider-message-2",
            "subject": "QA SINTÉTICO · Boletín técnico",
            "from": {"emailAddress": {"address": "boletin@example.test"}},
            "bodyPreview": "Newsletter sintética. Información de referencia.",
            "body": {"contentType": "text", "content": "Boletín de prueba. Todos los datos son sintéticos."},
            "receivedDateTime": "2026-10-08T16:00:00Z",
            "isRead": True,
            "parentFolderId": "qa-inbox",
            "webLink": None,
            "importance": "normal",
        },
    ]
    messages.extend({
        "id": f"qa-provider-message-{number}",
        "subject": f"QA SINTÉTICO · Boletín adicional {number:02d}",
        "from": {"emailAddress": {"address": "paginacion@example.test"}},
        "bodyPreview": "Newsletter sintética para comprobar las páginas de correo.",
        "body": {"contentType": "text", "content": "QA · DATOS SINTÉTICOS. Este mensaje comprueba la navegación paginada."},
        "receivedDateTime": "2026-10-07T16:00:00Z",
        "isRead": True,
        "parentFolderId": "qa-inbox",
        "webLink": None,
        "importance": "normal",
    } for number in range(3, 56))
    return httpx.Response(200, json={"value": messages, "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta?$deltatoken=qa-only"})


async def capture_via_mcp(thread_id: str):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    token_file = initialize()
    env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG") if key in os.environ}
    env.update({
        "PYTHONPATH": str(ROOT / "integrations" / "hermes-personal" / "src"),
        "HERALD_PERSONAL_URL": "http://127.0.0.1:8788",
        "HERALD_PERSONAL_TOKEN_FILE": str(token_file),
    })
    server = StdioServerParameters(command=sys.executable, args=["-m", "herald_hermes"], env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert any(tool.name == "personal_mail_to_task" for tool in tools.tools)
            result = await session.call_tool("personal_mail_to_task", {"thread_id": thread_id})
            if result.isError:
                raise RuntimeError("Synthetic MCP capture was rejected")
            task = json.loads(result.content[0].text)
            print(json.dumps({"task_id": task["id"], "transport": "official-mcp-stdio"}))


def serve():
    import httpx
    import uvicorn
    from herald_personal.api import create_app
    from herald_personal.config import Settings
    from herald_personal.providers.graph import GraphProvider

    token_file = initialize()
    settings = Settings(data_dir=QA / "data", api_token_file=token_file, mail_draft_enabled=False, mail_archive_enabled=False)
    adapter = GraphProvider("qa-synthetic-provider-only", client=httpx.Client(transport=httpx.MockTransport(graph_fixture), trust_env=False))
    application = create_app(settings, providers={"microsoft365": adapter})
    uvicorn.run(application, host="127.0.0.1", port=8788, log_level="warning", access_log=False)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--mcp-capture":
        asyncio.run(capture_via_mcp(sys.argv[2]))
    elif len(sys.argv) == 1:
        serve()
    else:
        raise SystemExit("Usage: qa-personal-service.py [--mcp-capture THREAD_ID]")
