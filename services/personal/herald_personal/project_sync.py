"""Read a configured build feed and GitHub; publish one atomic local snapshot.

Run with an operator-owned 0600 config, from the existing scheduler. This module
never starts coding sessions, merges PRs, or modifies the remote project.
"""

import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

import httpx
from pydantic import Field, ValidationError, field_validator

from .config import TokenSource
from .models import InputModel, Title, utc_now
from .projects import (
    Key,
    ProjectInputItem,
    ProjectSnapshot,
    PullRequest,
    Repository,
    RunStatus,
    aware,
)


class SyncFailure(ValueError):
    """Fixed error code safe for logs and the local API."""


class RunMetadata(InputModel):
    title: Title
    branch: str | None = Field(default=None, max_length=300)


class TrackedWork(RunMetadata):
    key: Key


class SyncConfig(InputModel):
    project: Title
    source_id: Key
    label: Title
    status_url: str = Field(max_length=1000)
    status_username: str | None = Field(default=None, max_length=100)
    status_password_file: Path | None = None
    repository: Repository
    gh_path: Path
    connection_file: Path
    interval_seconds: int = Field(default=900, ge=30, le=86400)
    run_metadata: dict[str, RunMetadata] = Field(default_factory=dict)
    tracked_prs: list[int] = Field(default_factory=list, max_length=30)
    tracked_work: list[TrackedWork] = Field(default_factory=list, max_length=30)
    coverage_notes: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("gh_path", "connection_file", "status_password_file")
    @classmethod
    def absolute(cls, value: Path | None) -> Path | None:
        if value is not None and not value.is_absolute():
            raise ValueError("Se requiere una ruta absoluta.")
        return value

    @field_validator("status_url")
    @classmethod
    def origin(cls, value: str) -> str:
        url = urlsplit(value)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.fragment
            or url.query
        ):
            raise ValueError("El origen requiere HTTPS sin credenciales ni parámetros.")
        return value


def private_json(path: Path) -> dict[str, Any]:
    try:
        with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))) as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_mode & 0o077
                or info.st_size > 65536
                or info.st_uid != os.getuid()
            ):
                raise ValueError()
            value = json.load(stream)
            if not isinstance(value, dict):
                raise ValueError()
            return value
    except (OSError, ValueError):
        raise SyncFailure("configuration_invalid") from None


def fetch_status(config: SyncConfig) -> dict[str, Any]:
    password = (
        TokenSource(path=config.status_password_file).read()
        if config.status_password_file
        else None
    )
    if config.status_password_file and (not password or not config.status_username):
        raise SyncFailure("source_unavailable")
    try:
        with (
            httpx.Client(timeout=20, follow_redirects=False, trust_env=False) as client,
            client.stream(
                "GET",
                config.status_url,
                auth=(config.status_username or "", password) if password else None,
            ) as response,
        ):
            response.raise_for_status()
            raw = bytearray()
            for part in response.iter_bytes():
                raw.extend(part)
                if len(raw) > 1_000_000:
                    raise SyncFailure("source_invalid")
        value = json.loads(raw)
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("runs"), list)
            or len(value["runs"]) > 170
        ):
            raise SyncFailure("source_invalid")
        return value
    except httpx.HTTPError:
        raise SyncFailure("source_unavailable") from None
    except (ValueError, UnicodeError):
        raise SyncFailure("source_invalid") from None


def fetch_prs(config: SyncConfig) -> list[dict[str, Any]]:
    try:
        result = subprocess.run(
            [
                str(config.gh_path),
                "pr",
                "list",
                "-R",
                config.repository,
                "--state",
                "all",
                "--json",
                "number,state,headRefName,title,updatedAt",
                "--limit",
                "200",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "GH_PROMPT_DISABLED": "1"},
        )
        if result.returncode or len(result.stdout) > 1_000_000:
            raise SyncFailure("github_unavailable")
        items = json.loads(result.stdout)
        # A capped inventory cannot prove absence of an older branch's PR.
        if (
            not isinstance(items, list)
            or len(items) >= 200
            or any(not isinstance(i, dict) for i in items)
        ):
            raise SyncFailure("github_unavailable")
        return items
    except (OSError, subprocess.SubprocessError, ValueError):
        raise SyncFailure("github_unavailable") from None


def build_snapshot(
    config: SyncConfig,
    feed: dict[str, Any],
    prs: list[dict[str, Any]],
    *,
    github_error: bool = False,
    attempted_at: str | None = None,
) -> ProjectSnapshot:
    warnings = list(config.coverage_notes)
    source_time = feed.get("generado")
    try:
        source_time = aware(source_time) if isinstance(source_time, str) else None
    except ValueError:
        source_time = None
    if source_time is None:
        warnings.append(
            "El origen no entrega una fecha con zona horaria; no se confirma actividad en vivo."
        )
    by_branch = {p["headRefName"]: p for p in sorted(prs, key=lambda p: int(p["number"]))}
    by_number = {int(p["number"]): p for p in prs}
    used = set()

    def pull(value: dict[str, Any] | None) -> PullRequest | None:
        if not value:
            return None
        used.add(value["number"])
        return PullRequest(
            repository=config.repository,
            number=value["number"],
            state=value["state"],
            updated_at=value["updatedAt"],
        )

    items = []
    for run in feed["runs"]:
        key = run["id"]
        metadata = config.run_metadata.get(key)
        branch = metadata.branch if metadata else run.get("branch")
        pr = by_branch.get(branch) if branch else None
        # Unambiguous numeric PR references are resolved against this configured repository.
        references = run.get("pr", [])
        if (
            not pr
            and isinstance(references, list)
            and len(references) == 1
            and isinstance(references[0], int)
        ):
            pr = by_number.get(references[0])
        status = {
            "done": "completed",
            "completed": "completed",
            "running": "running",
            "queued": "queued",
            "failed": "failed",
            "error": "failed",
            "cancelled": "cancelled",
        }.get(run.get("status"), "unknown")
        items.append(
            ProjectInputItem(
                key=key,
                title=metadata.title if metadata else run.get("nombre") or key,
                run_id=key,
                run_status=cast(RunStatus, status),
                branch=branch,
                pr=pull(pr),
            )
        )
    for work in config.tracked_work:
        if work.key not in {item.key for item in items}:
            items.append(
                ProjectInputItem(
                    key=work.key,
                    title=work.title,
                    branch=work.branch,
                    pr=pull(by_branch.get(work.branch)) if work.branch else None,
                )
            )
    for number in config.tracked_prs:
        if number in used:
            continue
        pr = by_number.get(number)
        if pr:
            items.append(
                ProjectInputItem(
                    key=f"{config.source_id}-pr-{number}",
                    title=pr["title"],
                    branch=pr["headRefName"],
                    pr=pull(pr),
                )
            )
        elif not github_error:
            warnings.append(f"El PR #{number} configurado no aparece en la consulta de GitHub.")
    problems = feed.get("problemas")
    if isinstance(problems, list) and problems:
        warnings.append(f"El origen informa {len(problems)} problemas. Revisar su diagnóstico.")
    return ProjectSnapshot(
        project=config.project,
        label=config.label,
        interval_seconds=config.interval_seconds,
        attempted_at=attempted_at or utc_now(),
        source_updated_at=source_time,
        github_error=github_error,
        warnings=warnings,
        items=items,
    )


def collect_snapshot(config: SyncConfig) -> ProjectSnapshot:
    started = utc_now()
    try:
        feed = fetch_status(config)
    except SyncFailure as error:
        return ProjectSnapshot(
            project=config.project,
            label=config.label,
            interval_seconds=config.interval_seconds,
            attempted_at=started,
            error="source_invalid" if str(error) == "source_invalid" else "source_unavailable",
            warnings=config.coverage_notes,
        )
    github_error = False
    try:
        prs = fetch_prs(config)
    except SyncFailure:
        prs, github_error = [], True
    try:
        return build_snapshot(config, feed, prs, github_error=github_error, attempted_at=started)
    except (KeyError, TypeError, ValueError):
        return ProjectSnapshot(
            project=config.project,
            label=config.label,
            interval_seconds=config.interval_seconds,
            attempted_at=started,
            error="source_invalid",
            warnings=config.coverage_notes,
        )


def publish(config: SyncConfig, snapshot: ProjectSnapshot) -> None:
    connection = private_json(config.connection_file)
    try:
        origin = urlsplit(connection["url"])
        # This scheduler only writes to the user's local shared service.
        if (
            origin.scheme != "http"
            or origin.hostname not in {"127.0.0.1", "localhost", "::1"}
            or origin.path not in {"", "/"}
            or origin.username
            or origin.password
            or origin.query
            or origin.fragment
        ):
            raise ValueError()
        token = TokenSource(path=Path(connection["tokenFile"])).read()
        if not token:
            raise ValueError()
        with httpx.Client(timeout=20, follow_redirects=False, trust_env=False) as client:
            response = client.put(
                connection["url"].rstrip("/") + f"/v1/project-sources/{config.source_id}",
                headers={"Authorization": f"Bearer {token}"},
                json=snapshot.model_dump(),
            )
            response.raise_for_status()
    except (KeyError, ValueError, httpx.HTTPError):
        raise SyncFailure("herald_unavailable") from None


def main() -> int:
    try:
        if len(sys.argv) != 2:
            raise SyncFailure("configuration_required")
        config = SyncConfig.model_validate(private_json(Path(sys.argv[1])))
        snapshot = collect_snapshot(config)
        publish(config, snapshot)
        print(
            json.dumps(
                {
                    "source_id": config.source_id,
                    "items": len(snapshot.items),
                    "error": snapshot.error,
                    "github_error": snapshot.github_error,
                    "attempted_at": snapshot.attempted_at,
                }
            )
        )
        return 1 if snapshot.error or snapshot.github_error else 0
    except (SyncFailure, ValidationError) as error:
        print(
            json.dumps(
                {"error": str(error) if isinstance(error, SyncFailure) else "configuration_invalid"}
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
