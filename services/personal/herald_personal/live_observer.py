"""Optional continuous, metadata-only observer owned by the personal service."""

import asyncio
import fcntl
import importlib
import json
import os
import stat
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .models import utc_now
from .planning import Observation, Planning


class ObservationClient:
    """Restrict the collector to observation reads/writes in the canonical DB."""

    def __init__(self, planning: Planning):
        self.planning = planning

    def request(self, method: str, path: str, body: Any = None) -> Any:
        if method == "GET" and path == "/v1/agent-observations":
            return {"items": self.planning.observations()}
        if method == "PUT" and path.startswith("/v1/agent-observations/"):
            return self.planning.observe(
                path.rsplit("/", 1)[1], Observation.model_validate(body)
            ).model_dump()
        raise ValueError("Observer route denied")


class LiveObserver:
    def __init__(
        self, config: Path | None, planning: Planning, *, poller: Callable[..., Any] | None = None
    ):
        self.config = config
        self.client = ObservationClient(planning)
        self.poller = poller
        self.last_poll_at: str | None = None
        self.errors: list[str] = []

    def snapshot(self) -> dict[str, Any]:
        return {
            "configured": self.config is not None,
            "interval_seconds": 5,
            "last_poll_at": self.last_poll_at,
            "errors": self.errors.copy(),
        }

    def tick(self) -> None:
        if self.config is None:
            return
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(self.config, flags)) as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 200_000:
                    raise ValueError("Private config required")
                config = json.load(stream)
            # The legacy scheduled observer uses this same lock; no duplicate publisher.
            with open(str(self.config.resolve()) + ".lock", "a+") as lock:
                os.chmod(lock.name, 0o600)
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return
                poller = self.poller or importlib.import_module("herald_hermes.observer").poll
                result = poller(config, self.client)
            self.errors = [
                x
                for x in result.get("errors", [])
                if x
                in {
                    "claude_unavailable",
                    "opencode_unavailable",
                    "claude_not_configured",
                    "opencode_not_configured",
                }
            ]
        except Exception:
            self.errors = ["observer_unavailable"]
        self.last_poll_at = utc_now()

    async def run(self) -> None:
        while self.config is not None:
            await asyncio.to_thread(self.tick)
            await asyncio.sleep(5)
