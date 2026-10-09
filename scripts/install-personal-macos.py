#!/usr/bin/env python3
"""Install only this user's owned Herald runtime outside macOS protected Documents."""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

LABEL = "dev.josetabora.herald-personal"
URL = "http://127.0.0.1:8787"
OWNER_FILE = ".herald-personal-install.json"
MAIL_KEYS = {
    "HERALD_MAIL_WORKSPACE_URL",
    "HERALD_MAIL_WORKSPACE_TOKEN_FILE",
    "HERALD_MICROSOFT365_MSAL_CACHE",
    "HERALD_MICROSOFT365_CLIENT_ID",
    "HERALD_MICROSOFT365_TENANT_ID",
    "HERALD_MICROSOFT365_TOKEN_FILE",
    "HERALD_GMAIL_TOKEN_FILE",
}
MAIL_FILES = {
    "HERALD_MAIL_WORKSPACE_TOKEN_FILE": "mail-workspace-token",
    "HERALD_MICROSOFT365_MSAL_CACHE": "microsoft365-msal.json",
    "HERALD_MICROSOFT365_TOKEN_FILE": "microsoft365-token",
    "HERALD_GMAIL_TOKEN_FILE": "gmail-token",
}
ENTRYPOINT = '''"""Owned LaunchAgent entry point; the PID file is observation only."""
import os
from pathlib import Path

from herald_personal.__main__ import main

pid_path = Path(__file__).resolve().parent.parent / "run" / "service.pid"
descriptor = os.open(
    pid_path,
    os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0),
    0o600,
)
with os.fdopen(descriptor, "w") as stream:
    stream.write(str(os.getpid()) + "\\n")
try:
    main()
finally:
    if pid_path.is_file() and not pid_path.is_symlink():
        if pid_path.read_text().strip() == str(os.getpid()):
            pid_path.unlink()
'''


def canonical(path: Path) -> Path:
    value = Path(os.path.abspath(path.expanduser()))
    for part in (value, *value.parents):
        if part.is_symlink():
            raise ValueError("No se permiten enlaces simbólicos en las rutas del instalador.")
    return value


def validate_file(path: Path, *, private: bool = False, limit: int = 5_000_000) -> None:
    canonical(path)
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise ValueError("Se requiere un archivo regular propio, sin enlaces simbólicos.")
        if private and metadata.st_mode & 0o077:
            raise ValueError("Las credenciales y configuración privada requieren permisos 0600.")
        if metadata.st_size > limit:
            raise ValueError("Un archivo de instalación excede su límite de tamaño.")
    except OSError as error:
        raise ValueError(
            "Falta un archivo requerido o no se puede leer de forma segura."
        ) from error


def read_file(path: Path, *, private: bool = False, limit: int = 5_000_000) -> bytes:
    validate_file(path, private=private, limit=limit)
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as stream:
            content = stream.read(limit + 1)
        if len(content) > limit:
            raise ValueError("Un archivo de instalación excede su límite de tamaño.")
        return content
    except OSError as error:
        raise ValueError(
            "Falta un archivo requerido o no se puede leer de forma segura."
        ) from error


def read_json(path: Path, *, private: bool = True) -> dict[str, Any]:
    try:
        result = json.loads(read_file(path, private=private))
    except (ValueError, UnicodeError) as error:
        raise ValueError("El archivo de configuración no es un JSON privado válido.") from error
    if not isinstance(result, dict):
        raise ValueError("La configuración debe ser un objeto JSON.")
    return result


def private_dir(path: Path, *, preserve_permissions: bool = False) -> None:
    canonical(path)
    if path.exists() and (not path.is_dir() or path.stat().st_uid != os.getuid()):
        raise ValueError("El directorio de instalación no pertenece a este usuario.")
    existed = path.exists()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not existed or not preserve_permissions:
        path.chmod(0o700)


def private_write(path: Path, content: bytes, *, preserve_parent: bool = False) -> None:
    private_dir(path.parent, preserve_permissions=preserve_parent)
    if path.exists() or path.is_symlink():
        read_file(path, private=True)
    temporary = path.with_name(path.name + ".tmp-" + uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_json(path: Path, value: dict[str, Any]) -> None:
    private_write(path, (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode())


def owner_record(repo: Path) -> dict[str, Any]:
    return {"version": 1, "owner": LABEL, "sourceRepo": str(repo)}


def require_owned_target(repo: Path, target: Path, *, may_create: bool) -> None:
    canonical(target)
    if target.is_relative_to(repo) or "Documents" in target.parts:
        raise ValueError("El servicio instalado debe quedar fuera de Documents y del repositorio.")
    if not target.exists():
        if may_create:
            return
        raise ValueError("No existe un destino propio instalado.")
    if not target.is_dir() or target.stat().st_uid != os.getuid():
        raise ValueError("El destino no pertenece a este usuario.")
    marker = target / OWNER_FILE
    if not marker.exists() or read_json(marker) != owner_record(repo):
        raise ValueError("El destino no tiene la propiedad de esta instalación. No se modificó.")


def tree_files(source: Path, *, python_only: bool = False) -> list[tuple[Path, Path]]:
    canonical(source)
    if not source.is_dir():
        raise ValueError("Falta un directorio requerido de módulos o skills.")
    result: list[tuple[Path, Path]] = []
    for parent, directories, files in os.walk(source, followlinks=False):
        directories[:] = [
            item for item in directories if item not in {"__pycache__", ".pytest_cache"}
        ]
        for name in directories:
            if (Path(parent) / name).is_symlink():
                raise ValueError("Los módulos y skills no pueden contener enlaces simbólicos.")
        for name in files:
            path = Path(parent) / name
            if name == ".DS_Store" or (python_only and path.suffix != ".py"):
                continue
            read_file(path)
            result.append((path, path.relative_to(source)))
    return result


def copy_tree(
    source: Path, destination: Path, *, python_only: bool = False, preserve: bool = False
) -> None:
    private_dir(destination)
    for path, relative in tree_files(source, python_only=python_only):
        target = destination / relative
        if preserve and target.exists():
            read_file(target, private=True)
            continue
        private_write(target, read_file(path))


def mail_settings(repo: Path, target: Path) -> tuple[dict[str, str], list[tuple[Path, Path]]]:
    source = repo / ".runtime/private/mail-settings.json"
    existing = target / "private/mail-settings.json"
    settings = (
        read_json(existing) if existing.exists() else read_json(source) if source.exists() else {}
    )
    if not settings.keys() <= MAIL_KEYS:
        raise ValueError("La configuración de correo contiene campos no permitidos.")
    rewritten: dict[str, str] = {}
    copies: list[tuple[Path, Path]] = []
    for key, value in settings.items():
        if (
            not isinstance(value, str)
            or not value
            or len(value) > 4096
            or "\n" in value
            or "\r" in value
        ):
            raise ValueError("La configuración de correo tiene valores inválidos.")
        if key in MAIL_FILES:
            origin = canonical(Path(value))
            allowed_parent = target / "private" if existing.exists() else repo / ".runtime/private"
            if not origin.is_relative_to(allowed_parent):
                raise ValueError("Solo se importan credenciales del directorio privado aislado.")
            read_file(origin, private=True)
            destination = target / "private" / MAIL_FILES[key]
            if not destination.exists():
                copies.append((origin, destination))
            else:
                read_file(destination, private=True)
            rewritten[key] = str(destination)
        else:
            rewritten[key] = value
    return rewritten, copies


def profile_source(repo: Path, role: str) -> Path:
    home = repo / ".runtime" / ("hermes-home" if role == "personal" else "coder-home")
    return home if home.exists() else repo / "integrations/hermes-personal/profiles" / role


def rewrite_profile(content: str, role: str, target: Path) -> str:
    lines = content.splitlines()
    starts = [index for index, line in enumerate(lines) if re.fullmatch(r"mcp_servers:\s*", line)]
    if len(starts) != 1:
        raise ValueError("El perfil aislado requiere un único bloque mcp_servers propio.")
    start = starts[0]
    end = next(
        (
            index
            for index in range(start + 1, len(lines))
            if lines[index] and not lines[index][0].isspace() and not lines[index].startswith("#")
        ),
        len(lines),
    )
    servers = [
        line.strip().split(":", 1)[0]
        for line in lines[start + 1 : end]
        if re.match(r"^  [A-Za-z0-9_-]+:\s*$", line)
    ]
    if servers != ["herald_personal"]:
        raise ValueError("El instalador no reemplaza servidores MCP ajenos en un perfil.")
    env = {
        "PYTHONPATH": str(target / "lib"),
        "HERALD_PERSONAL_URL": URL,
        "HERALD_PERSONAL_TOKEN_FILE": str(target / "private/api-token"),
        "HERALD_MCP_ROLE": role,
    }
    if role == "personal":
        env.update(HERALD_PERSONAL_ALLOW_MAIL_DRAFT="0", HERALD_PERSONAL_ALLOW_MAIL_ARCHIVE="0")
    else:
        env.update(
            HERALD_CODING_CONFIG=str(target / "private/operator.json"),
            HERALD_PERSONAL_PROJECT_RUNS="1",
        )
    managed = [
        "mcp_servers:",
        "  herald_personal:",
        "    command: " + json.dumps(str(target / ".venv/bin/python")),
        "    args: [-m, herald_hermes]",
        "    env:",
    ]
    managed += ["      " + key + ": " + json.dumps(value) for key, value in env.items()]
    managed += ["    sampling:", "      enabled: false"]
    return "\n".join([*lines[:start], *managed, *lines[end:]]) + "\n"


def validate_profiles(repo: Path, target: Path) -> None:
    for role, home in (("personal", "hermes-home"), ("coder", "coder-home")):
        source = (
            target / home
            if (target / home / "config.yaml").exists()
            else profile_source(repo, role)
        )
        rewrite_profile(read_file(source / "config.yaml").decode(), role, target)
        read_file(source / "SOUL.md")
        if (source / "auth.json").exists() or (source / "auth.json").is_symlink():
            read_file(source / "auth.json", private=True)
        skills = source / "skills"
        if not skills.exists():
            skills = repo / "integrations/hermes-personal/skills"
        tree_files(skills)


def install_profiles(repo: Path, target: Path) -> None:
    for role, home in (("personal", "hermes-home"), ("coder", "coder-home")):
        destination = target / home
        source = (
            destination if (destination / "config.yaml").exists() else profile_source(repo, role)
        )
        config = rewrite_profile(read_file(source / "config.yaml").decode(), role, target)
        soul = read_file(source / "SOUL.md")
        auth = (
            read_file(source / "auth.json", private=True)
            if (source / "auth.json").exists()
            else None
        )
        private_dir(destination)
        private_write(destination / "config.yaml", config.encode())
        if not (destination / "SOUL.md").exists():
            private_write(destination / "SOUL.md", soul)
        if auth is not None and not (destination / "auth.json").exists():
            private_write(destination / "auth.json", auth)
        skills = source / "skills"
        if not skills.exists():
            skills = repo / "integrations/hermes-personal/skills"
        copy_tree(skills, destination / "skills", preserve=True)
    operator = target / "private/operator.json"
    if not operator.exists():
        write_json(
            operator,
            {
                "version": 1,
                "state_dir": str(target / "coding-runs"),
                "max_deadline_seconds": 600,
                "max_attempts": 1,
                "max_active_runs": 1,
                "workspaces": {},
                "agents": {},
                "scopes": {},
            },
        )
    else:
        read_json(operator)
    private_dir(target / "coding-runs")


def backup_sqlite(source: Path, destination: Path) -> None:
    validate_file(source, private=True, limit=5_000_000_000)
    private_dir(destination.parent)
    temporary = destination.with_name(destination.name + ".tmp-" + uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    try:
        with (
            closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=10)) as origin,
            closing(sqlite3.connect(temporary)) as copied,
        ):
            origin.backup(copied, pages=256, sleep=0.01)
            if copied.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("La copia SQLite no pasó su comprobación de integridad.")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def validate_plist(repo: Path, target: Path, plist_path: Path) -> dict[str, Any] | None:
    if not plist_path.exists() and not plist_path.is_symlink():
        return None
    try:
        value = plistlib.loads(read_file(plist_path, private=True))
    except (ValueError, plistlib.InvalidFileException) as error:
        raise ValueError("El LaunchAgent existente no es un archivo propio válido.") from error
    if not isinstance(value, dict):
        raise ValueError("El LaunchAgent existente no contiene un objeto de configuración.")
    arguments = value.get("ProgramArguments", [])
    legacy = value.get("WorkingDirectory") == str(repo / "services/personal") and arguments[:3] == [
        str(repo / "services/personal/.venv/bin/python"),
        "-m",
        "herald_personal",
    ]
    installed = value.get("WorkingDirectory") == str(target / "lib") and arguments[:2] == [
        str(target / ".venv/bin/python"),
        str(target / "lib/personal_service_entry.py"),
    ]
    if value.get("Label") != LABEL or not (legacy or installed):
        raise ValueError("El LaunchAgent pertenece a otro programa o repositorio. No se modificó.")
    return value


def run_command(
    arguments: list[str], *, cwd: Path | None = None, check: bool = True
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments, cwd=cwd, check=check, text=True, capture_output=True, timeout=600
    )


def stop_owned(plist_path: Path, previous: dict[str, Any] | None) -> bool:
    domain = f"gui/{os.getuid()}/{LABEL}"
    state = run_command(["launchctl", "print", domain], check=False)
    if state.returncode != 0:
        return False
    fields = dict(
        line.strip().split(" = ", 1) for line in state.stdout.splitlines() if " = " in line
    )
    if (
        previous is None
        or fields.get("path") != str(plist_path)
        or fields.get("program") != previous["ProgramArguments"][0]
        or fields.get("working directory") != previous["WorkingDirectory"]
    ):
        raise ValueError(
            "El proceso registrado no coincide con el LaunchAgent propio. No se detuvo."
        )
    run_command(["launchctl", "bootout", domain])
    return True


def port_available() -> bool:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(("127.0.0.1", 8787)) != 0


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


def wait_ready(target: Path) -> bool:
    token = read_file(target / "private/api-token", private=True, limit=65_536).decode().strip()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(
        URL + "/v1/status", headers={"Authorization": "Bearer " + token}
    )
    deadline = time.monotonic() + 60
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            with opener.open(request, timeout=min(1, remaining)) as response:
                if response.status == 200:
                    return True
        except (OSError, urllib.error.URLError):
            pass
        if (remaining := deadline - time.monotonic()) > 0:
            time.sleep(min(0.25, remaining))
    return False


def install(
    repo: Path, target: Path, launch_agents: Path, *, dry_run: bool = False
) -> dict[str, Any]:
    repo, target, launch_agents = canonical(repo), canonical(target), canonical(launch_agents)
    require_owned_target(repo, target, may_create=True)
    plist_path = launch_agents / (LABEL + ".plist")
    previous = validate_plist(repo, target, plist_path)
    for source in (
        repo / "services/personal/herald_personal",
        repo / "integrations/hermes-personal/src/herald_hermes",
    ):
        tree_files(source, python_only=True)
    read_file(repo / "services/personal/requirements.lock")
    source_token = (
        target / "private/api-token"
        if (target / "private/api-token").exists()
        else repo / ".runtime/private/api-token"
    )
    token = read_file(source_token, private=True, limit=65_536)
    if not token.strip() or any(char.isspace() for char in token.decode().strip()):
        raise ValueError("El token privado debe ser una cadena no vacía en una sola línea.")
    settings, credential_copies = mail_settings(repo, target)
    validate_profiles(repo, target)
    source_database = repo / ".runtime/data/personal.sqlite3"
    target_database = target / "data/personal.sqlite3"
    for database in (source_database, target_database):
        if database.exists() or database.is_symlink():
            validate_file(database, private=True, limit=5_000_000_000)
    uv = shutil.which("uv")
    if uv is None:
        raise ValueError("Instale uv antes de preparar el servicio local.")
    result: dict[str, Any] = {
        "target": str(target),
        "url": URL,
        "label": LABEL,
        "dry_run": dry_run,
        "connectionFile": str(target / "connection.json"),
        "running": False,
    }
    if dry_run:
        return result
    stop_owned(plist_path, previous)
    for _ in range(20):
        if port_available():
            break
        time.sleep(0.1)
    else:
        raise ValueError("El puerto 8787 está ocupado. No se detuvo ningún proceso ajeno.")
    for directory in (
        target,
        target / "private",
        target / "data",
        target / "logs",
        target / "run",
        target / "backups",
    ):
        private_dir(directory)
    write_json(target / OWNER_FILE, owner_record(repo))
    if not (target / "private/api-token").exists():
        private_write(target / "private/api-token", token)
    for origin, destination in credential_copies:
        private_write(destination, read_file(origin, private=True))
    write_json(target / "private/mail-settings.json", settings)
    if target_database.exists():
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S") + "-" + uuid4().hex[:8]
        backup_sqlite(target_database, target / "backups" / ("personal-" + stamp + ".sqlite3"))
    elif source_database.exists():
        backup_sqlite(source_database, target_database)
    copy_tree(
        repo / "services/personal/herald_personal", target / "lib/herald_personal", python_only=True
    )
    copy_tree(
        repo / "integrations/hermes-personal/src/herald_hermes",
        target / "lib/herald_hermes",
        python_only=True,
    )
    private_write(target / "lib/personal_service_entry.py", ENTRYPOINT.encode())
    private_write(
        target / "requirements.lock", read_file(repo / "services/personal/requirements.lock")
    )
    install_profiles(repo, target)
    run_command(
        [uv, "venv", str(target / ".venv"), "--python", "3.13", "--allow-existing"], cwd=target
    )
    python = target / ".venv/bin/python"
    run_command(
        [
            uv,
            "pip",
            "install",
            "--python",
            str(python),
            "--require-hashes",
            "-r",
            str(target / "requirements.lock"),
        ],
        cwd=target,
    )
    run_command(
        [str(python), "-c", "import herald_personal, herald_hermes, mcp, msal, uvicorn"],
        cwd=target / "lib",
    )
    env = {
        "PYTHONPATH": str(target / "lib"),
        "HERALD_PERSONAL_DATA_DIR": str(target / "data"),
        "HERALD_PERSONAL_TOKEN_FILE": str(target / "private/api-token"),
        "HERALD_PERSONAL_MAIL_DRAFT_ENABLED": "false",
        "HERALD_PERSONAL_MAIL_ARCHIVE_ENABLED": "false",
        "TZ": "America/Tegucigalpa",
        **settings,
    }
    payload: dict[str, Any] = {
        "Label": LABEL,
        "ProgramArguments": [
            str(python),
            str(target / "lib/personal_service_entry.py"),
            "--host",
            "127.0.0.1",
            "--port",
            "8787",
        ],
        "WorkingDirectory": str(target / "lib"),
        "EnvironmentVariables": env,
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 15,
        "StandardOutPath": str(target / "logs/service.stdout.log"),
        "StandardErrorPath": str(target / "logs/service.stderr.log"),
    }
    for path in (Path(payload["StandardOutPath"]), Path(payload["StandardErrorPath"])):
        if not path.exists():
            private_write(path, b"")
        else:
            read_file(path, private=True)
    private_dir(launch_agents, preserve_permissions=True)
    private_write(plist_path, plistlib.dumps(payload), preserve_parent=True)
    run_command(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist_path)])
    if not wait_ready(target):
        raise ValueError(
            "El servicio no confirmó autenticación. Revise los logs privados del destino."
        )
    write_json(
        target / "connection.json", {"url": URL, "tokenFile": str(target / "private/api-token")}
    )
    write_json(
        repo / ".runtime/private/installed-runtime.json",
        {
            "dataDir": str(target / "data"),
            "tokenFile": str(target / "private/api-token"),
            "hermesHome": str(target / "hermes-home"),
            "pythonPath": str(python),
            "connectionFile": str(target / "connection.json"),
        },
    )
    result["running"] = True
    return result


def uninstall(
    repo: Path, target: Path, launch_agents: Path, *, dry_run: bool = False
) -> dict[str, Any]:
    repo, target, launch_agents = canonical(repo), canonical(target), canonical(launch_agents)
    require_owned_target(repo, target, may_create=False)
    plist_path = launch_agents / (LABEL + ".plist")
    previous = validate_plist(repo, target, plist_path)
    if not dry_run:
        stop_owned(plist_path, previous)
        if previous is not None:
            plist_path.unlink()
    return {"label": LABEL, "target": str(target), "dry_run": dry_run, "data_preserved": True}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Instala el servicio privado Herald Personal en macOS"
    )
    parser.add_argument("action", choices=("install", "uninstall"))
    parser.add_argument(
        "--dry-run", action="store_true", help="Valida y muestra el plan sin cambios ni procesos"
    )
    parser.add_argument(
        "--target", type=Path, default=Path.home() / "Library/Application Support/Herald Personal"
    )
    arguments = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Este instalador utiliza LaunchAgents de macOS.")
    repo = Path(__file__).resolve().parents[1]
    launch_agents = Path.home() / "Library/LaunchAgents"
    action = install if arguments.action == "install" else uninstall
    try:
        result = action(repo, arguments.target, launch_agents, dry_run=arguments.dry_run)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, sqlite3.Error, subprocess.SubprocessError):
        print(
            "No se completó la operación. Revise propiedad, permisos, puerto y logs privados; "
            "no se eliminaron datos.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
