"""Silent delegated refresh against a private MSAL cache, never an interactive login."""

import fcntl
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any

import msal
import requests


class _BoundedSession(requests.Session):
    def __init__(self) -> None:
        super().__init__()
        self.trust_env = False

    def request(
        self, method: str, url: str | bytes, *args: Any, **kwargs: Any
    ) -> requests.Response:
        kwargs["timeout"] = 15
        kwargs["allow_redirects"] = False
        return super().request(method, url, *args, **kwargs)


class MsalTokenSource:
    def __init__(
        self,
        cache_path: Path,
        client_id: str,
        tenant_id: str,
        *,
        scopes: tuple[str, ...] = ("Mail.Read",),
    ) -> None:
        self.cache_path = cache_path
        self.client_id = client_id
        self.tenant_id = tenant_id
        self.scopes = scopes

    @property
    def configured(self) -> bool:
        """Inspect only local configuration; opening a UI never refreshes credentials."""
        if not re.fullmatch(r"[a-fA-F0-9-]{36}", self.client_id):
            return False
        if not (
            self.tenant_id in {"common", "organizations", "consumers"}
            or re.fullmatch(r"[a-fA-F0-9-]{36}", self.tenant_id)
        ):
            return False
        try:
            info = self.cache_path.lstat()
            return (
                stat.S_ISREG(info.st_mode)
                and not info.st_mode & 0o077
                and info.st_uid == os.getuid()
                and 0 < info.st_size <= 4_000_000
            )
        except OSError:
            return False

    def read(self) -> str | None:
        if not self.configured:
            return None
        try:
            lock_path = self.cache_path.with_suffix(self.cache_path.suffix + ".lock")
            flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(lock_path, flags, 0o600), "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                return self._refresh()
        except Exception:
            # Provider error bodies can contain tokens, identifiers or interaction URLs.
            return None

    def _refresh(self) -> str | None:
        cache = msal.SerializableTokenCache()
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(self.cache_path, flags), "r", encoding="utf-8") as stream:
            info = os.fstat(stream.fileno())
            if info.st_mode & 0o077 or info.st_size > 4_000_000:
                return None
            cache.deserialize(stream.read(4_000_001))
        with _BoundedSession() as http_client:
            app = msal.PublicClientApplication(
                client_id=self.client_id,
                authority=f"https://login.microsoftonline.com/{self.tenant_id}",
                token_cache=cache,
                http_client=http_client,
            )
            accounts = app.get_accounts()
            if len(accounts) != 1:
                return None
            result = app.acquire_token_silent(list(self.scopes), account=accounts[0])
        if cache.has_state_changed:
            fd, name = tempfile.mkstemp(prefix=".msal-", dir=self.cache_path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    stream.write(cache.serialize())
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(name, self.cache_path)
            finally:
                Path(name).unlink(missing_ok=True)
        token = result.get("access_token") if isinstance(result, dict) else None
        if (
            isinstance(token, str)
            and 0 < len(token) < 16_384
            and not any(c.isspace() for c in token)
        ):
            return token
        return None
