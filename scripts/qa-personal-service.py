#!/usr/bin/env python3
"""Explicit synthetic-only Electron QA service; never reads operator mail credentials."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import secrets
import sys
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlparse

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
            assert any(tool.name == "mail_workspace_capture" for tool in tools.tools)
            result = await session.call_tool("mail_workspace_capture", {"clave": thread_id})
            if result.isError:
                raise RuntimeError("Synthetic MCP capture was rejected")
            task = json.loads(result.content[0].text)
            print(json.dumps({"task_id": task["id"], "transport": "official-mcp-stdio"}))


def serve():
    import httpx
    import uvicorn
    from herald_personal.api import create_app
    from herald_personal.config import Settings

    token_file = initialize()
    native = ThreadingHTTPServer(("127.0.0.1", 8098), NativeMailFixture)
    Thread(target=native.serve_forever, daemon=True).start()
    settings = Settings(data_dir=QA / "data", api_token_file=token_file, mail_workspace_url="http://127.0.0.1:8098", mail_draft_enabled=False, mail_archive_enabled=False)
    application = create_app(settings)
    uvicorn.run(application, host="127.0.0.1", port=8788, log_level="warning", access_log=False)


class NativeMailFixture(BaseHTTPRequestHandler):
    """An explicit synthetic domain app proves the guest/HTTP/identity seam, not JEV logic."""

    def log_message(self, *_args):
        pass

    def do_GET(self):
        path = urlparse(self.path).path
        with (QA / "provider-requests.jsonl").open("a") as stream:
            stream.write(json.dumps({"method": "GET", "path": path}) + "\n")
        if path == "/_agent-native/actions/mail-counts":
            value = {"ventanaDias": 60, "total": 55, "noLeidos": 3,
                     "porEstado": {"debo_respuesta": 2, "esperando_respuesta": 1},
                     "porPrioridad": {"alta": 2},
                     "ultimaSincronizacion": {"estado": "ok", "fin": datetime.now(UTC).isoformat()}}
        elif path == "/_agent-native/actions/mail-get-item":
            value = {"item": {"clave": "MAIL-1", "asunto": "QA SINTÉTICO · Revisar propuesta", "estado": "debo_respuesta"}}
        elif path.startswith("/_agent-native/actions/"):
            self.send_error(403)
            return
        else:
            content = '''<!doctype html><html lang="es"><title>QA · Correo sintético</title>
            <style>body{font:16px system-ui;padding:28px;background:#f7f9fc;color:#182438}a{display:inline-block;margin:12px;color:#164d92}textarea{display:block;width:90%;min-height:120px}h1{font-size:24px}</style>
            <h1>QA · Aplicación de correo sintética</h1><p>Datos de prueba para verificar la integración nativa.</p>
            <a href="/correo/MAIL-1">Abrir MAIL-1</a><a href="/seguimiento">Seguimiento</a><a href="/home">Ruta fuera de correo</a>
            <p id="route"></p><label>Borrador sintético<textarea aria-label="Borrador sintético"></textarea></label>
            <script>document.querySelector('#route').textContent=location.pathname;</script></html>'''.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html;charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        content = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--mcp-capture":
        asyncio.run(capture_via_mcp(sys.argv[2]))
    elif len(sys.argv) == 1:
        serve()
    else:
        raise SystemExit("Usage: qa-personal-service.py [--mcp-capture THREAD_ID]")
