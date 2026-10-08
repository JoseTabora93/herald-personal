"""Durable, bounded CLI supervision. Operator scopes are the execution authority.

No shell, arbitrary command arguments, permission approval, or PID supplied by a
caller. Each detached worker owns its Popen handle and alone signals that child.
This is process supervision, not a host filesystem/network security sandbox.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .bridge import BridgeError, PersonalClient

ACTIVE = {"queued", "running", "cancel_requested"}
TERMINAL = {"completed", "failed", "timed_out", "cancelled", "interrupted"}
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
MAX_OUTPUT = 1_000_000
AUTH_ENV = {
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
    "AZURE_OPENAI_API_KEY",
}


class SupervisorError(ValueError):
    pass


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _identifier(value):
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise SupervisorError("ID inválido.")
    return value


def _within(path, parent):
    return path == parent or parent in path.parents


def build_command(agent, config, scope, session_id):
    """Only trusted operator configuration reaches argv; prompt remains data."""
    env = {
        key: value
        for key, value in os.environ.items()
        if key
        in {
            "HOME",
            "USER",
            "LOGNAME",
            "PATH",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "SSL_CERT_FILE",
        }
    }
    for key in config.get("credential_env", []):
        if key not in AUTH_ENV:
            raise SupervisorError("Variable de credencial no permitida.")
        if key in os.environ:
            env[key] = os.environ[key]
    argv = [config["executable"]]
    model = config.get("model")
    if model is not None and (
        not isinstance(model, str)
        or not model
        or model.startswith("-")
        or len(model) > 200
    ):
        raise SupervisorError("Modelo inválido en configuración del operador.")
    if agent == "claude":
        argv += [
            "-p",
            "--output-format",
            "json",
            "--session-id",
            session_id,
            "--permission-mode",
            "manual",
            "--permission-prompts",
            "none",
            "--restricted",
            "--strict-mcp-config",
            "--no-chrome",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--setting-sources",
            "",
            "--max-budget-usd",
            str(config.get("max_budget_usd", 2)),
        ]
        if model:
            argv += ["--model", model]
        return argv, scope["prompt"], env
    if agent != "opencode":
        raise SupervisorError("Agente no permitido.")
    # v2 is the locally verified installed CLI. v1 must be selected explicitly.
    variant = config.get("cli_variant", "v2")
    argv += ["run", "--format", "json"]
    if variant == "v2":
        argv += ["--standalone"]
    elif variant != "v1":
        raise SupervisorError("Variante OpenCode desconocida.")
    argv += ["--agent", "herald-supervised", "--title", "Herald " + session_id]
    if model:
        argv += ["--model", model]
    argv += ["--", scope["prompt"]]
    return argv, None, env


def _load_config(path):
    try:
        path = Path(path).expanduser().resolve(strict=True)
        if path.stat().st_mode & 0o077 or path.stat().st_size > 200_000:
            raise SupervisorError(
                "Configuración requiere permisos 0600 y tamaño acotado."
            )
        data = json.loads(path.read_text())
        if (
            data.get("version") != 1
            or not isinstance(data.get("workspaces"), dict)
            or not isinstance(data.get("scopes"), dict)
        ):
            raise SupervisorError("Configuración del operador inválida.")
        state_input = Path(data["state_dir"]).expanduser()
        state = state_input.resolve()
        if (
            not state_input.is_absolute()
            or state == Path.home() / ".hermes"
            or _within(state, Path.home() / ".hermes")
        ):
            raise SupervisorError("El estado debe estar aislado de Hermes global.")
        if (
            type(data.get("max_active_runs", 2)) is not int
            or not 1 <= data.get("max_active_runs", 2) <= 4
        ):
            raise SupervisorError(
                "Máximo de ejecuciones simultáneas debe ser de 1 a 4."
            )
        for name, workspace in data["workspaces"].items():
            _identifier(name)
            original = Path(workspace["path"]).expanduser()
            resolved = original.resolve(strict=True)
            if (
                not original.is_absolute()
                or not resolved.is_dir()
                or original != resolved
            ):
                raise SupervisorError(
                    "Workspace debe ser ruta absoluta canónica existente, sin symlinks."
                )
            if _within(path, resolved) or _within(state, resolved):
                raise SupervisorError(
                    "Config y estado deben quedar fuera del workspace del agente."
                )
            workspace["path"] = str(resolved)
        for name, agent in data["agents"].items():
            if name not in {"claude", "opencode"}:
                raise SupervisorError("Agente no soportado.")
            executable = Path(agent["executable"]).expanduser().resolve(strict=True)
            if not executable.is_file() or not os.access(executable, os.X_OK):
                raise SupervisorError("Ejecutable del operador no disponible.")
            if any(
                _within(executable, Path(w["path"]))
                for w in data["workspaces"].values()
            ):
                raise SupervisorError("Ejecutable debe estar fuera del workspace.")
            agent["executable"] = str(executable)
            budget = agent.get("max_budget_usd", 2)
            if not isinstance(budget, (int, float)) or not 0 < budget <= 20:
                raise SupervisorError("Presupuesto CLI debe estar entre 0 y 20 USD.")
        for scope_id, scope in data["scopes"].items():
            _identifier(scope_id)
            workspace = data["workspaces"][scope["workspace"]]
            if (
                scope["agent"] not in workspace["agents"]
                or scope["agent"] not in data["agents"]
            ):
                raise SupervisorError("Agente no autorizado para este workspace.")
            if (
                not isinstance(scope["prompt"], str)
                or not scope["prompt"].strip()
                or len(scope["prompt"]) > 20000
            ):
                raise SupervisorError("Alcance debe contener prompt exacto acotado.")
            for key, default, hard_max in [
                ("deadline_seconds", 600, 3600),
                ("max_attempts", 1, 3),
            ]:
                value = scope.get(key, default)
                top = (
                    data.get("max_" + key, hard_max)
                    if key == "deadline_seconds"
                    else data.get("max_attempts", 3)
                )
                if type(value) is not int or not 1 <= value <= min(top, hard_max):
                    raise SupervisorError(
                        "Límite de alcance fuera del máximo del operador."
                    )
                scope[key] = value
            if scope.get("task_id"):
                _identifier(scope["task_id"])
        return path, data, state
    except SupervisorError:
        raise
    except (OSError, ValueError, KeyError, TypeError):
        raise SupervisorError(
            "Configuración, rutas o campos del operador inválidos."
        ) from None


class Supervisor:
    def __init__(self, config_path):
        self.config_path, self.config, self.state = _load_config(config_path)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state.chmod(0o700)

    @contextmanager
    def _lock(self):
        with open(self.state / ".lock", "a+") as handle:
            os.chmod(handle.name, 0o600)
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def _path(self, run_id):
        try:
            normalized = str(uuid.UUID(run_id))
        except (ValueError, TypeError, AttributeError):
            raise SupervisorError("run_id debe ser UUID válido.") from None
        if normalized != run_id:
            raise SupervisorError("run_id no canónico.")
        return self.state / (run_id + ".json")

    def _read(self, run_id):
        try:
            return json.loads(self._path(run_id).read_text())
        except (OSError, json.JSONDecodeError):
            raise SupervisorError(
                "Ejecución no encontrada o estado ilegible."
            ) from None

    def _write(self, record):
        record["revision"] = record.get("revision", 0) + 1
        record["updated_at"] = _now()
        path = self._path(record["run_id"])
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w") as handle:
            os.chmod(tmp, 0o600)
            json.dump(record, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)

    def scopes(self):
        return [
            {"scope_id": name, **scope} for name, scope in self.config["scopes"].items()
        ]

    def _scope_digest(self, scope_id):
        scope = self.config["scopes"][scope_id]
        return _digest(
            {
                "scope": scope,
                "agent": self.config["agents"][scope["agent"]],
                "workspace": self.config["workspaces"][scope["workspace"]],
            }
        )

    def _ensure_capacity(self, workspace, excluding=None):
        """Called only under the state lock, equally for start and explicit retry."""
        active = [
            json.loads(path.read_text())
            for path in self.state.glob("????????-????-????-????-????????????.json")
        ]
        active = [
            run
            for run in active
            if run["status"] in ACTIVE and run["run_id"] != excluding
        ]
        workspace_path = self.config["workspaces"][workspace]["path"]
        if len(active) >= self.config.get("max_active_runs", 2) or any(
            run.get("workspace_path") == workspace_path or run["workspace"] == workspace
            for run in active
        ):
            raise SupervisorError(
                "Workspace ocupado o límite de ejecuciones simultáneas alcanzado."
            )

    def start(self, scope_id, request_id):
        _identifier(scope_id)
        _identifier(request_id)
        if scope_id not in self.config["scopes"]:
            raise SupervisorError("Alcance no aprobado por el operador.")
        scope = self.config["scopes"][scope_id]
        fingerprint = self._scope_digest(scope_id)
        with self._lock():
            for path in self.state.glob("????????-????-????-????-????????????.json"):
                previous = json.loads(path.read_text())
                if previous["request_id"] == request_id:
                    if previous["scope_digest"] != fingerprint:
                        raise SupervisorError(
                            "request_id reutilizado con alcance distinto."
                        )
                    return previous
            workspace_path = self.config["workspaces"][scope["workspace"]]["path"]
            self._ensure_capacity(scope["workspace"])
            record = {
                "run_id": str(uuid.uuid4()),
                "request_id": request_id,
                "scope_id": scope_id,
                "scope_digest": fingerprint,
                "task_id": scope.get("task_id"),
                "workspace": scope["workspace"],
                "workspace_path": workspace_path,
                "agent": scope["agent"],
                "status": "queued",
                "created_at": _now(),
                "verification": "not_run",
                "attempts": [],
                "cancel_requested": False,
                "generation": str(uuid.uuid4()),
            }
            self._write(record)
        self._publish(record)
        self._spawn(record)
        return record

    def _spawn(self, record):
        # Worker startup uses our fixed module and operator file, never caller argv.
        env = dict(os.environ)
        env["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)
        try:
            worker = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "herald_hermes.supervisor",
                    "--config",
                    str(self.config_path),
                    "worker",
                    record["run_id"],
                    record["generation"],
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                env=env,
                close_fds=True,
            )
            threading.Thread(target=worker.wait, daemon=True).start()
        except OSError:
            with self._lock():
                latest = self._read(record["run_id"])
                latest["status"] = "failed"
                latest["error"] = "worker_start_failed"
                self._write(latest)
            self._publish(latest)
            raise SupervisorError("No se pudo iniciar worker.") from None

    def status(self, run_id):
        with self._lock():
            record = self._read(run_id)
            stamp = record.get("heartbeat_at", record["updated_at"])
            age = (
                time.time()
                - datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
            )
            if record["status"] in ACTIVE and age > 30:
                # Never signal persisted PIDs after a restart: they may have been reused.
                record["status"] = "interrupted"
                record["error"] = "worker_heartbeat_lost_manual_review_required"
                self._write(record)
        self._publish(record)
        return record

    def list_runs(self):
        return [
            self.status(path.stem)
            for path in sorted(
                self.state.glob("????????-????-????-????-????????????.json"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
        ]

    def cancel(self, run_id):
        with self._lock():
            record = self._read(run_id)
            if record["status"] in ACTIVE:
                record["cancel_requested"] = True
                record["status"] = "cancel_requested"
                self._write(record)
        self._publish(record)
        return record

    def retry(self, run_id, *, confirmed=False):
        if confirmed is not True:
            raise SupervisorError("Reintento requiere confirmación humana.")
        with self._lock():
            record = self._read(run_id)
            scope = self.config["scopes"].get(record["scope_id"])
            if (
                not scope
                or self._scope_digest(record["scope_id"]) != record["scope_digest"]
            ):
                raise SupervisorError("Alcance cambió; crear una ejecución nueva.")
            if record["status"] not in {"failed", "timed_out", "cancelled"}:
                raise SupervisorError(
                    "Estado no reintentable; un worker interrumpido requiere revisión del operador."
                )
            if len(record["attempts"]) >= scope["max_attempts"]:
                raise SupervisorError("Máximo de intentos alcanzado.")
            self._ensure_capacity(scope["workspace"], excluding=run_id)
            record.update(
                status="queued", cancel_requested=False, generation=str(uuid.uuid4())
            )
            record.pop("heartbeat_at", None)
            self._write(record)
        self._publish(record)
        self._spawn(record)
        return record

    @staticmethod
    def projection(record):
        keys = (
            "run_id",
            "revision",
            "scope_id",
            "task_id",
            "workspace",
            "agent",
            "status",
            "created_at",
            "updated_at",
            "verification",
        )
        result = {key: record[key] for key in keys}
        attempt_keys = (
            "number",
            "status",
            "started_at",
            "finished_at",
            "exit_code",
            "stdout_sha256",
            "stderr_sha256",
            "outcome",
        )
        result["attempts"] = [
            {key: a.get(key) for key in attempt_keys} for a in record["attempts"]
        ]
        return result

    def _publish(self, record):
        # Optional service projection. Local execution truth survives any API outage.
        if os.environ.get("HERALD_PERSONAL_PROJECT_RUNS") != "1":
            return
        try:
            PersonalClient.from_env().request(
                "PUT", "/v1/agent-runs/" + record["run_id"], self.projection(record)
            )
        except (BridgeError, OSError):
            return  # status/list republishes the same durable snapshot, never reruns a task.

    def _heartbeat(self, run_id, generation):
        with self._lock():
            record = self._read(run_id)
            if record["generation"] != generation or record["status"] not in ACTIVE:
                return True
            record["heartbeat_at"] = _now()
            self._write(record)
            return record["cancel_requested"]

    def work(self, run_id, generation):
        with self._lock():
            record = self._read(run_id)
            if record["generation"] != generation or record["status"] not in {
                "queued",
                "cancel_requested",
            }:
                return
            if (
                record["scope_id"] not in self.config["scopes"]
                or self._scope_digest(record["scope_id"]) != record["scope_digest"]
            ):
                record["status"] = "failed"
                record["error"] = "operator_scope_changed_before_start"
                self._write(record)
                return
            if record["cancel_requested"]:
                record["status"] = "cancelled"
                self._write(record)
                self._publish(record)
                return
            scope = self.config["scopes"][record["scope_id"]]
            attempt = {
                "number": len(record["attempts"]) + 1,
                "status": "running",
                "started_at": _now(),
                "finished_at": None,
                "exit_code": None,
                "stdout_sha256": None,
                "stderr_sha256": None,
                "outcome": None,
                "session_id": str(uuid.uuid4()),
            }
            record["attempts"].append(attempt)
            record["status"] = "running"
            record["heartbeat_at"] = _now()
            self._write(record)
        self._publish(record)
        config = self.config["agents"][scope["agent"]]
        stdout = stderr = b""
        try:
            argv, stdin, env = build_command(
                scope["agent"], config, scope, attempt["session_id"]
            )
            if scope["agent"] == "opencode":
                self._opencode_runtime(env, config, run_id, attempt["number"])
            proc = subprocess.Popen(
                argv,
                cwd=self.config["workspaces"][scope["workspace"]]["path"],
                stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                start_new_session=True,
                close_fds=True,
            )
            stdout, stderr, code, outcome = self._capture(
                proc, stdin, scope["deadline_seconds"], run_id, generation
            )
        except (OSError, SupervisorError):
            code, outcome = None, "process_start_failed"
        secrets = [
            value
            for key, value in os.environ.items()
            if (key in AUTH_ENV or key == "HERALD_PERSONAL_TOKEN") and len(value) >= 8
        ]
        for secret in secrets:
            stdout = stdout.replace(secret.encode(), b"[REDACTED]")
            stderr = stderr.replace(secret.encode(), b"[REDACTED]")
        result, json_valid = _parse_output(stdout)
        if outcome == "exited":
            outcome = (
                "completed"
                if code == 0 and json_valid and not _result_error(result)
                else "failed"
            )
        status = outcome if outcome in TERMINAL else "failed"
        prefix = self.state / f"{run_id}.{attempt['number']}"
        for suffix, content in [("stdout.json", stdout), ("stderr.txt", stderr)]:
            path = Path(str(prefix) + "." + suffix)
            path.write_bytes(content)
            path.chmod(0o600)
        with self._lock():
            record = self._read(run_id)
            if record["generation"] != generation:
                return
            record["status"] = status
            record["attempts"][-1].update(
                status=status,
                finished_at=_now(),
                exit_code=code,
                outcome=outcome,
                stdout_sha256=hashlib.sha256(stdout).hexdigest(),
                stderr_sha256=hashlib.sha256(stderr).hexdigest(),
                result=result,
                json_valid=json_valid,
            )
            self._write(record)
        self._publish(record)

    def _opencode_runtime(self, env, config, run_id, number):
        runtime = self.state / "runtime" / run_id / str(number)
        config_dir = runtime / "config" / "opencode"
        config_dir.mkdir(parents=True, mode=0o700)
        # All unapproved tools are denied. No saved global approvals are reused.
        variant = config.get("cli_variant", "v2")
        if variant == "v2":
            content = {
                "update": "disable",
                "plugins": [],
                "permissions": [{"action": "*", "resource": "*", "effect": "deny"}],
                "agents": {
                    "herald-supervised": {
                        "mode": "primary",
                        "description": "Análisis supervisado sin aprobación automática",
                        "permissions": [
                            {"action": "*", "resource": "*", "effect": "deny"}
                        ],
                    }
                },
                "experimental": {
                    "policies": [
                        {"action": "permission", "resource": "*", "effect": "deny"}
                    ]
                },
            }
        else:
            content = {
                "autoupdate": False,
                "plugin": [],
                "permission": {"*": "deny"},
                "agent": {
                    "herald-supervised": {
                        "mode": "primary",
                        "description": "Análisis supervisado",
                        "permission": {"*": "deny"},
                    }
                },
            }
        (config_dir / "opencode.json").write_text(json.dumps(content))
        for key, folder in [
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_CACHE_HOME", "cache"),
        ]:
            env[key] = str(runtime / folder)
        if variant == "v1":
            env["OPENCODE_CONFIG_CONTENT"] = json.dumps(content)

    def _capture(self, proc, stdin, deadline_seconds, run_id, generation):
        selector = selectors.DefaultSelector()
        stdout, stderr = bytearray(), bytearray()
        buffers = {proc.stdout.fileno(): stdout, proc.stderr.fileno(): stderr}
        for stream in [proc.stdout, proc.stderr]:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ)
        if stdin is not None:
            os.set_blocking(proc.stdin.fileno(), False)
            selector.register(proc.stdin, selectors.EVENT_WRITE)
            pending = memoryview(stdin.encode())
        started = last_heartbeat = time.monotonic()
        outcome = "exited"
        try:
            while selector.get_map():
                now = time.monotonic()
                if now - started >= deadline_seconds:
                    outcome = "timed_out"
                    break
                if now - last_heartbeat >= 0.2:
                    last_heartbeat = now
                    if self._heartbeat(run_id, generation):
                        outcome = "cancelled"
                        break
                for key, mask in selector.select(timeout=0.05):
                    stream = key.fileobj
                    if mask & selectors.EVENT_WRITE:
                        try:
                            written = os.write(stream.fileno(), pending[:4096])
                            pending = pending[written:]
                        except BrokenPipeError:
                            pending = b""
                        if not pending:
                            selector.unregister(stream)
                            stream.close()
                    else:
                        chunk = os.read(stream.fileno(), 65536)
                        if not chunk:
                            selector.unregister(stream)
                            stream.close()
                        else:
                            buffer = buffers[stream.fileno()]
                            buffer.extend(chunk[: MAX_OUTPUT - len(buffer)])
                            if len(buffer) >= MAX_OUTPUT:
                                outcome = "output_limit"
                                break
                if outcome != "exited":
                    break
            # Even a process that closes its output early must respect the deadline.
            while outcome == "exited" and proc.poll() is None:
                if time.monotonic() - started >= deadline_seconds:
                    outcome = "timed_out"
                    break
                if self._heartbeat(run_id, generation):
                    outcome = "cancelled"
                    break
                time.sleep(0.05)
        finally:
            selector.close()
            if proc.poll() is None:
                # Group belongs to this live Popen child, not a PID loaded from disk.
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                    proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            proc.wait(timeout=2)
            for stream in [proc.stdin, proc.stdout, proc.stderr]:
                if stream and not stream.closed:
                    stream.close()
        return bytes(stdout), bytes(stderr), proc.returncode, outcome


def _parse_output(raw):
    try:
        text = raw.decode("utf-8")
        try:
            result = json.loads(text)
        except json.JSONDecodeError:
            result = [json.loads(line) for line in text.splitlines() if line.strip()]
        return result, bool(result)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, False


def _result_error(result):
    if isinstance(result, list):
        return any(_result_error(item) for item in result)
    return isinstance(result, dict) and (
        result.get("is_error") is True or result.get("type") == "error"
    )


def main():
    parser = argparse.ArgumentParser(
        description="Supervisión de alcances aprobados; stdout JSON"
    )
    parser.add_argument("--config", required=True)
    sub = parser.add_subparsers(dest="action", required=True)
    start = sub.add_parser("start")
    start.add_argument("scope_id")
    start.add_argument("request_id")
    for name in ["status", "cancel", "retry"]:
        command = sub.add_parser(name)
        command.add_argument("run_id")
        if name == "retry":
            command.add_argument("--confirmed", action="store_true")
    sub.add_parser("list")
    sub.add_parser("scopes")
    worker = sub.add_parser("worker")
    worker.add_argument("run_id")
    worker.add_argument("generation")
    args = parser.parse_args()
    try:
        supervisor = Supervisor(args.config)
        if args.action == "worker":
            supervisor.work(args.run_id, args.generation)
            return
        if args.action == "start":
            result = supervisor.start(args.scope_id, args.request_id)
        elif args.action == "list":
            result = {"items": supervisor.list_runs()}
        elif args.action == "scopes":
            result = {"items": supervisor.scopes()}
        elif args.action == "retry":
            result = supervisor.retry(args.run_id, confirmed=args.confirmed)
        else:
            result = getattr(supervisor, args.action)(args.run_id)
        print(json.dumps(result, ensure_ascii=False))
    except (SupervisorError, OSError) as exc:
        print(
            json.dumps(
                {
                    "error": str(exc)
                    if isinstance(exc, SupervisorError)
                    else "Error local de supervisión."
                }
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
