"""Operator-owned configuration and reloadable credentials."""

import json
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field


class CredentialSource(Protocol):
    @property
    def configured(self) -> bool: ...

    def read(self) -> str | None: ...


@dataclass(frozen=True)
class TokenSource:
    value: str | None = field(default=None, repr=False)
    path: Path | None = field(default=None, repr=False)

    @property
    def configured(self) -> bool:
        return self.read() is not None

    def read(self) -> str | None:
        content = self.value
        if content is None and self.path is not None:
            try:
                flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                with os.fdopen(os.open(self.path, flags), "r", encoding="utf-8") as stream:
                    metadata = os.fstat(stream.fileno())
                    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
                        return None
                    content = stream.read(65_537)
                if len(content) > 65_536:
                    return None
                if content.lstrip().startswith("{"):
                    decoded = json.loads(content)
                    content = decoded.get("access_token") if isinstance(decoded, dict) else None
            except (OSError, UnicodeError, ValueError):
                return None
        if not isinstance(content, str):
            return None
        token = content.strip()
        if not token or len(token) > 16_384 or any(char.isspace() for char in token):
            return None
        return token if all(ord(char) > 32 and ord(char) < 127 for char in token) else None


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True)

    data_dir: Path = Path.home() / ".local" / "share" / "herald-personal"
    api_token: str | None = Field(default=None, repr=False)
    api_token_file: Path | None = Field(default=None, repr=False)
    microsoft365_token: str | None = Field(default=None, repr=False)
    microsoft365_token_file: Path | None = Field(default=None, repr=False)
    microsoft365_msal_cache: Path | None = Field(default=None, repr=False)
    microsoft365_client_id: str | None = Field(default=None, repr=False)
    microsoft365_tenant_id: str | None = Field(default=None, repr=False)
    gmail_token: str | None = Field(default=None, repr=False)
    gmail_token_file: Path | None = Field(default=None, repr=False)
    mail_workspace_url: str | None = Field(default=None, repr=False)
    mail_workspace_token_file: Path | None = Field(default=None, repr=False)
    observer_config_file: Path | None = None
    mail_draft_enabled: bool = False
    mail_archive_enabled: bool = False
    max_sync_pages: int = Field(default=3, ge=1, le=10)
    max_sync_messages: int = Field(default=150, ge=1, le=1000)
    requests_per_minute: int = Field(default=240, ge=1, le=10_000)

    @property
    def credential(self) -> TokenSource:
        return TokenSource(self.api_token, self.api_token_file)

    @classmethod
    def from_env(cls) -> "Settings":
        def path(name: str) -> Path | None:
            value = os.environ.get(name)
            return Path(value).expanduser() if value else None

        return cls(
            data_dir=path("HERALD_PERSONAL_DATA_DIR") or cls.model_fields["data_dir"].default,
            api_token=os.environ.get("HERALD_PERSONAL_TOKEN"),
            api_token_file=path("HERALD_PERSONAL_TOKEN_FILE"),
            microsoft365_token=os.environ.get("HERALD_MICROSOFT365_TOKEN"),
            microsoft365_token_file=path("HERALD_MICROSOFT365_TOKEN_FILE"),
            microsoft365_msal_cache=path("HERALD_MICROSOFT365_MSAL_CACHE"),
            microsoft365_client_id=os.environ.get("HERALD_MICROSOFT365_CLIENT_ID"),
            microsoft365_tenant_id=os.environ.get("HERALD_MICROSOFT365_TENANT_ID"),
            gmail_token=os.environ.get("HERALD_GMAIL_TOKEN"),
            gmail_token_file=path("HERALD_GMAIL_TOKEN_FILE"),
            mail_workspace_url=os.environ.get("HERALD_MAIL_WORKSPACE_URL"),
            mail_workspace_token_file=path("HERALD_MAIL_WORKSPACE_TOKEN_FILE"),
            observer_config_file=path("HERALD_OBSERVER_CONFIG"),
            mail_draft_enabled=os.environ.get("HERALD_PERSONAL_MAIL_DRAFT_ENABLED") == "true",
            mail_archive_enabled=os.environ.get("HERALD_PERSONAL_MAIL_ARCHIVE_ENABLED") == "true",
        )
