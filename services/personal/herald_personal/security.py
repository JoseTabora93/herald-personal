"""A single-user bearer boundary with bounded request bodies and request rates."""

import secrets
import threading
import time
from collections import defaultdict, deque

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import Settings


class RequestGuard:
    def __init__(self, app: ASGIApp, settings: Settings):
        self.app, self.settings = app, settings
        self.windows: dict[str, deque[float]] = defaultdict(deque)
        self.lock = threading.Lock()

    def _limited(self, expensive: bool) -> bool:
        now = time.monotonic()
        with self.lock:
            for key in ("all", "expensive") if expensive else ("all",):
                window = self.windows[key]
                while window and window[0] <= now - 60:
                    window.popleft()
                limit = (
                    min(30, self.settings.requests_per_minute)
                    if key == "expensive"
                    else self.settings.requests_per_minute
                )
                if len(window) >= limit:
                    return True
            self.windows["all"].append(now)
            if expensive:
                self.windows["expensive"].append(now)
        return False

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not (
            scope["path"] == "/v1" or scope["path"].startswith("/v1/")
        ):
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        token = self.settings.credential.read()
        if token is None:
            response = JSONResponse(
                {"detail": "Configure HERALD_PERSONAL_TOKEN o un archivo privado de token."},
                status_code=503,
            )
            await response(scope, receive, send)
            return
        authorization = headers.get(b"authorization", b"")
        if not secrets.compare_digest(authorization, b"Bearer " + token.encode("ascii")):
            await JSONResponse(
                {"detail": "Autorización requerida."},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )(scope, receive, send)
            return
        expensive = (
            scope["method"] == "POST"
            and "/mail/" in scope["path"]
            and not scope["path"].endswith("/task")
        )
        if self._limited(expensive):
            await JSONResponse(
                {"detail": "Límite de solicitudes alcanzado. Espere un minuto."},
                status_code=429,
                headers={"Retry-After": "60"},
            )(scope, receive, send)
            return
        content: list[bytes] = []
        total = 0
        while True:
            chunk = await receive()
            if chunk["type"] == "http.disconnect":
                return
            data = chunk.get("body", b"")
            total += len(data)
            if total > 256_000:
                await JSONResponse(
                    {"detail": "El cuerpo de la solicitud excede el límite."}, status_code=413
                )(scope, receive, send)
                return
            content.append(data)
            if not chunk.get("more_body", False):
                break
        delivered = False

        async def bounded_receive() -> Message:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"".join(content), "more_body": False}
            return await receive()

        async def secured_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                message["headers"] = [
                    *message.get("headers", []),
                    (b"cache-control", b"no-store"),
                    (b"x-content-type-options", b"nosniff"),
                ]
            await send(message)

        await self.app(scope, bounded_receive, secured_send)
