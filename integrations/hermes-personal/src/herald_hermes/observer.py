"""Observe existing coding sessions through metadata APIs, without controlling them."""

from __future__ import annotations

import argparse
import base64
import fcntl
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .bridge import BridgeError, PersonalClient, _NoRedirect
from .runtime import RuntimeErrorSafe, bounded_run, private_json


class ObservationError(ValueError):
    pass


IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
ALIAS = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
MAX_SESSIONS = 100


def workspace_alias(directory, workspaces):
    if not isinstance(directory, str) or not Path(directory).is_absolute():
        return None
    resolved = Path(directory).resolve()
    matches = []
    for alias, path in workspaces.items():
        if not ALIAS.fullmatch(alias):
            raise ObservationError("Alias de workspace inválido.")
        root = Path(path).expanduser().resolve()
        if not root.is_dir():
            continue
        if resolved == root or root in resolved.parents:
            matches.append((len(root.parts), alias))
    return max(matches)[1] if matches else None


def _row(agent, session, workspace, status, source, now, signals, *, source_time=None):
    return {
        "observer_id": str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"herald:{agent}:{session}:{workspace}")
        ),
        "revision": 1,
        "observed_at": now,
        "agent": agent,
        "native_session_id": session,
        "workspace": workspace,
        "status": status,
        "evidence_source": source,
        "confidence": "low" if status == "unknown" else "high",
        "source_updated_at": source_time,
        "stale_after_seconds": 30,
        "signals": signals[:8],
        "verification": "not_run",
    }


def parse_claude_sessions(rows, workspaces, observed_at):
    if not isinstance(rows, list) or len(rows) > MAX_SESSIONS:
        raise ObservationError("Inventario Claude inválido o excesivo.")
    output = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        sid = item.get("sessionId")
        workspace = workspace_alias(item.get("cwd"), workspaces)
        if not workspace or not isinstance(sid, str) or not IDENTIFIER.fullmatch(sid):
            continue
        # Only explicit states from the public CLI count; OS state/mtime never do.
        state = {
            "busy": "active",
            "idle": "idle",
            "waiting": "waiting_input",
            "shell": "active",
        }.get(item.get("status"), "unknown")
        output.append(
            _row(
                "claude",
                sid,
                workspace,
                state,
                "claude_agents_cli",
                observed_at,
                ["public_cli_snapshot", "tests_not_observed"],
            )
        )
    return output


def collect_claude(executable, workspaces, observed_at, *, run=bounded_run):
    try:
        raw = run([executable, "agents", "--json"], timeout=10)
        return parse_claude_sessions(json.loads(raw), workspaces, observed_at)
    except (ValueError, OSError, TimeoutError):
        raise ObservationError(
            "No se pudo consultar el inventario público de Claude."
        ) from None


def _data(payload, expected):
    value = payload.get("data") if isinstance(payload, dict) else None
    return value if isinstance(value, expected) else None


def _source_time(value):
    value = value.get("updated") if isinstance(value, dict) else None
    try:
        if isinstance(value, (int, float)) and value > 0:
            return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError):
        pass
    return None


def parse_opencode_sessions(
    sessions, active, permissions, questions, workspaces, observed_at
):
    rows = _data(sessions, list)
    if rows is None or len(rows) > MAX_SESSIONS:
        raise ObservationError("Inventario OpenCode v2 inválido o excesivo.")
    active_map = _data(active, dict)
    permission_rows, question_rows = _data(permissions, list), _data(questions, list)
    permission_ids = {
        x.get("sessionID")
        for x in (permission_rows or [])
        if isinstance(x, dict) and isinstance(x.get("sessionID"), str)
    }
    question_ids = {
        x.get("sessionID")
        for x in (question_rows or [])
        if isinstance(x, dict) and isinstance(x.get("sessionID"), str)
    }
    output = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        sid = item.get("id")
        location = item.get("location")
        workspace = workspace_alias(
            location.get("directory") if isinstance(location, dict) else None,
            workspaces,
        )
        if not workspace or not isinstance(sid, str) or not IDENTIFIER.fullmatch(sid):
            continue
        state = "unknown"
        if active_map is not None:
            if sid not in active_map:
                state = "idle"
            elif isinstance(active_map[sid], dict):
                state = {
                    "running": "active",
                    "retry": "retrying",
                    "retrying": "retrying",
                }.get(active_map[sid].get("type"), "unknown")
        if sid in question_ids:
            state = "waiting_input"
        if sid in permission_ids:
            state = "waiting_permission"
        signals = ["public_v2_snapshot", "tests_not_observed"]
        if permission_rows is None:
            signals.append("permission_signal_unavailable")
        if question_rows is None:
            signals.append("question_signal_unavailable")
        # A prior successful execution does not mean tests passed. A session can
        # remain open after a turn, so an inactive snapshot is idle, never done.
        output.append(
            _row(
                "opencode", sid, workspace, state, "opencode_api", observed_at, signals,
                source_time=_source_time(item.get("time")),
            )
        )
    return output


class OpenCodeReader:
    """Fixed GET allowlist, loopback only; existing service credential stays in memory."""

    def __init__(self, service_file, *, budget_seconds=20):
        try:
            state = private_json(service_file)
            url, password = state.get("url", ""), state.get("password", "")
            parsed = urllib.parse.urlsplit(url)
            if (
                parsed.scheme != "http"
                or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
                or parsed.path not in ("", "/")
                or not isinstance(password, str)
                or not password
                or len(password) > 4096
            ):
                raise ObservationError("Servicio OpenCode local inválido.")
            self.base_url = url.rstrip("/")
            if not 0 < budget_seconds <= 30:
                raise ObservationError("Presupuesto HTTP inválido.")
            self._deadline = time.monotonic() + budget_seconds
            self._authorization = (
                "Basic " + base64.b64encode(("opencode:" + password).encode()).decode()
            )
            self._opener = urllib.request.build_opener(
                urllib.request.ProxyHandler({}), _NoRedirect()
            )
        except (OSError, ValueError):
            raise ObservationError(
                "Configure el service.json privado del OpenCode local."
            ) from None

    def get(self, path):
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise ObservationError("El inventario OpenCode agotó su presupuesto total.")
        split = urllib.parse.urlsplit(path)
        query = urllib.parse.parse_qs(split.query)
        allowed = split.path in {
            "/api/session",
            "/api/session/active",
            "/api/permission/request",
            "/api/question/request",
        }
        allowed = allowed or bool(
            re.fullmatch(
                r"/api/session/[A-Za-z0-9_-]{1,128}(?:/permission|/question)?",
                split.path,
            )
        )
        if (
            not allowed
            or split.scheme
            or split.netloc
            or split.fragment
            or ".." in path
            or "\\" in path
            or set(query) - {"limit", "cursor", "directory"}
            or len(path) > 4096
        ):
            raise ObservationError("Ruta de observación no permitida.")
        request = urllib.request.Request(
            self.base_url + path,
            method="GET",
            headers={
                "Authorization": self._authorization,
                "Accept": "application/json",
            },
        )
        try:
            with self._opener.open(request, timeout=min(3, remaining)) as response:
                if "application/json" not in response.headers.get("Content-Type", ""):
                    raise ObservationError(
                        "El servidor no devolvió la API JSON de OpenCode."
                    )
                raw = response.read(524289)
                if len(raw) > 524288:
                    raise ObservationError("La respuesta OpenCode supera el límite.")
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ObservationError("Respuesta OpenCode inválida.")
                return data
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            raise ObservationError(f"OpenCode no disponible (HTTP {code}).") from None
        except (urllib.error.URLError, OSError, ValueError):
            raise ObservationError(
                "OpenCode no disponible o respuesta inválida."
            ) from None


def collect_opencode(service_file, workspaces, observed_at):
    reader = OpenCodeReader(service_file)
    sessions = reader.get("/api/session?limit=50")
    active = reader.get("/api/session/active")
    # Fetch active sessions omitted by the bounded recent page. No transcript API.
    known = {r.get("id") for r in (_data(sessions, list) or []) if isinstance(r, dict)}
    for sid in list(_data(active, dict) or {})[:20]:
        if sid not in known and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", sid):
            detail = reader.get("/api/session/" + sid)
            if isinstance(detail.get("data"), dict):
                sessions["data"].append(detail["data"])
    permission_data, question_data = [], []
    permissions_ok = questions_ok = True
    # Session-scoped reads avoid treating the service launch cwd as every workspace.
    scoped = {
        r["native_session_id"]
        for r in parse_opencode_sessions(
            sessions, active, None, None, workspaces, observed_at
        )
    }
    active_ids = [
        x
        for x in (_data(active, dict) or {})
        if x in scoped and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", x)
    ][:20]
    for sid in active_ids:
        for kind, target in (
            ("permission", permission_data),
            ("question", question_data),
        ):
            try:
                payload = reader.get(f"/api/session/{sid}/{kind}")
                rows = _data(payload, list)
                if rows is None:
                    raise ObservationError("Formato de señal no disponible.")
                # Some API generations include closed requests. Only explicit pending
                # requests (or the pending-only shape with no status) count.
                target.extend(
                    {"sessionID": r.get("sessionID", sid)}
                    for r in rows
                    if isinstance(r, dict)
                    and r.get("status", "pending") == "pending"
                    and not r.get("resolvedAt")
                    and not r.get("reply")
                )
            except ObservationError:
                if kind == "permission":
                    permissions_ok = False
                else:
                    questions_ok = False
    return parse_opencode_sessions(
        sessions,
        active,
        {"data": permission_data} if permissions_ok else None,
        {"data": question_data} if questions_ok else None,
        workspaces,
        observed_at,
    )


def reconcile_observations(previous, rows, successful_agents, now):
    """Absence only proves closure in a complete live CLI inventory, not a recent page."""
    known = {row["observer_id"] for row in rows}
    closed = []
    for old in previous:
        if (old["agent"] == "claude" and "claude" in successful_agents
                and old["observer_id"] not in known and old["status"] != "ended"):
            row = _row("claude", old["native_session_id"], old["workspace"], "ended",
                       "claude_agents_cli", now, ["absent_from_live_inventory", "tests_not_observed"])
            closed.append(row)
    return closed


def publish_observations(client, rows):
    existing = client.request("GET", "/v1/agent-observations").get("items", [])
    revisions = {x["observer_id"]: x["revision"] for x in existing}
    results = []
    for row in rows:
        payload = {**row, "revision": revisions.get(row["observer_id"], 0) + 1}
        results.append(
            client.request(
                "PUT", "/v1/agent-observations/" + row["observer_id"], payload
            )
        )
    return results


def poll(config, client):
    workspaces = config.get("workspaces")
    if not isinstance(workspaces, dict) or not workspaces or len(workspaces) > 100:
        raise ObservationError("Configure una allowlist de workspaces del operador.")
    now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    rows, errors, successful = [], [], []
    for agent, field, collect in (
        ("claude", "claude_executable", collect_claude),
        ("opencode", "opencode_service_file", collect_opencode),
    ):
        if not config.get(field):
            errors.append(agent + "_not_configured")
            continue
        try:
            rows.extend(collect(config[field], workspaces, now))
            successful.append(agent)
        except ObservationError:
            errors.append(agent + "_unavailable")
    previous = client.request("GET", "/v1/agent-observations").get("items", [])
    rows += reconcile_observations(previous, rows, successful, now)
    stored = publish_observations(client, rows) if rows else []
    return {"observed": len(stored), "errors": errors, "verification": "not_run"}


def main():
    parser = argparse.ArgumentParser(
        description="Observador de metadatos de sesiones existentes"
    )
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        config = private_json(args.config)
        with open(str(Path(args.config).resolve()) + ".lock", "a+") as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print(json.dumps({"skipped": "observer_already_running"}))
                return
            print(
                json.dumps(poll(config, PersonalClient.from_env()), ensure_ascii=False)
            )
    except (ObservationError, RuntimeErrorSafe, BridgeError, OSError, ValueError):
        print(json.dumps({"error": "observer_unavailable", "verification": "not_run"}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
