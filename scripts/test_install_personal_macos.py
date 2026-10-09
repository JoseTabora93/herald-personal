"""Installer tests use temporary homes, SQLite and a fake process boundary only."""

import importlib.util
import json
import plistlib
import sqlite3
import subprocess
import sys
import urllib.request
import urllib.response
from contextlib import closing
from email.message import Message
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest


def load_installer():
    path = Path(__file__).with_name("install-personal-macos.py")
    spec = importlib.util.spec_from_file_location("install_personal_macos", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def private_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)
    path.chmod(0o600)


def fake_clock(module, monkeypatch):
    elapsed = [0.0]

    def sleep(delay):
        assert 0 < delay <= 1
        elapsed[0] += delay

    monkeypatch.setattr(
        module, "time", SimpleNamespace(monotonic=lambda: elapsed[0], sleep=sleep)
    )
    return elapsed


def test_installer_has_a_read_only_plan_entrypoint(source, destination, tmp_path, monkeypatch):
    module = load_installer()
    # The plan checks prerequisites but must never run them. CI need not have uv installed.
    monkeypatch.setattr(module.shutil, "which", lambda name: "/fixture/bin/uv" if name == "uv" else None)
    monkeypatch.setattr(module.subprocess, "run", lambda *args, **kwargs: pytest.fail("dry-run executed a subprocess"))
    result = module.install(source, destination, tmp_path / "LaunchAgents", dry_run=True)
    assert result["target"] == str(destination)
    assert not destination.exists()


@pytest.fixture
def source(tmp_path):
    repo = tmp_path / "Documents" / "herald-personal"
    private_write(repo / "services/personal/herald_personal/__init__.py", "")
    private_write(repo / "services/personal/herald_personal/__main__.py", "def main(): pass\n")
    private_write(repo / "services/personal/herald_personal/oauth.py", "")
    private_write(repo / "services/personal/requirements.lock", "mcp==1.30.0\nmsal==1.39.0\n")
    private_write(repo / "integrations/hermes-personal/src/herald_hermes/__init__.py", "")
    private_write(repo / "integrations/hermes-personal/src/herald_hermes/__main__.py", "")
    private_write(repo / ".runtime/private/api-token", "test-private-api-token\n")
    private_write(repo / ".runtime/private/microsoft365-msal.json", '{"private":"test-refresh"}')
    private_write(
        repo / ".runtime/private/mail-settings.json",
        json.dumps(
            {
                "HERALD_MICROSOFT365_MSAL_CACHE": str(
                    repo / ".runtime/private/microsoft365-msal.json"
                ),
                "HERALD_MICROSOFT365_CLIENT_ID": "11111111-1111-1111-1111-111111111111",
                "HERALD_MICROSOFT365_TENANT_ID": "organizations",
            }
        ),
    )
    for role, home in (("personal", "hermes-home"), ("coder", "coder-home")):
        config = (
            "timezone: America/Tegucigalpa\nmodel: operator-model\n"
            "approvals:\n  mode: manual\n  unattended_mode: deny\n"
            "mcp_servers:\n  herald_personal:\n"
            f"    command: {repo}/services/personal/.venv/bin/python\n"
            "    args: [-m, herald_hermes]\n    env:\n"
            f"      HERALD_MCP_ROLE: {role}\n"
            f"      HERALD_CODING_CONFIG: {repo}/.runtime/private/qa-operator.json\n"
        )
        private_write(repo / f".runtime/{home}/config.yaml", config)
        private_write(repo / f".runtime/{home}/SOUL.md", "Perfil aislado\n")
        private_write(
            repo / f".runtime/{home}/auth.json", '{"provider":"test-private-model-access"}'
        )
        private_write(repo / f".runtime/{home}/.env", "WHATSAPP_TOKEN=do-not-copy\n")
        private_write(repo / f".runtime/{home}/skills/compromisos/SKILL.md", "Compromisos reales\n")
    database = repo / ".runtime/data/personal.sqlite3"
    database.parent.mkdir(parents=True)
    with closing(sqlite3.connect(database)) as connection:
        connection.execute("CREATE TABLE evidence (id TEXT PRIMARY KEY, value TEXT)")
        connection.execute("INSERT INTO evidence VALUES ('existing','durable')")
        connection.commit()
    database.chmod(0o600)
    return repo


@pytest.fixture
def destination(tmp_path):
    return tmp_path / "Library" / "Application Support" / "Herald Personal"


@pytest.fixture
def host(source, destination, tmp_path, monkeypatch):
    module = load_installer()
    commands = []
    loaded = {"plist": None}
    launch_agents = tmp_path / "Library" / "LaunchAgents"

    def run(arguments, **kwargs):
        commands.append((arguments, kwargs))
        if arguments[0] == "launchctl" and arguments[1] == "print":
            plist = loaded["plist"]
            if plist is None:
                return subprocess.CompletedProcess(arguments, 113, stdout="", stderr="not found")
            value = plistlib.loads(plist.read_bytes())
            output = (
                f"path = {plist}\nprogram = {value['ProgramArguments'][0]}\n"
                f"working directory = {value['WorkingDirectory']}\n"
            )
            return subprocess.CompletedProcess(arguments, 0, stdout=output, stderr="")
        if arguments[0] == "launchctl" and arguments[1] == "bootout":
            loaded["plist"] = None
        if arguments[0] == "launchctl" and arguments[1] == "bootstrap":
            loaded["plist"] = Path(arguments[-1])
        if arguments[1:2] == ["venv"]:
            python = destination / ".venv/bin/python"
            private_write(python, "test interpreter")
        return subprocess.CompletedProcess(arguments, 0, stdout="", stderr="")

    monkeypatch.setattr(module, "run_command", run)
    monkeypatch.setattr(module.shutil, "which", lambda command: "/test/bin/uv")
    monkeypatch.setattr(module, "port_available", lambda: True)
    monkeypatch.setattr(module, "wait_ready", lambda target: True)
    return module, commands, loaded, launch_agents


def test_dry_run_describes_private_install_without_creating_files_or_processes(
    source, destination, host
):
    module, commands, _, launch_agents = host
    result = module.install(source, destination, launch_agents, dry_run=True)
    assert result["target"] == str(destination)
    assert result["url"] == "http://127.0.0.1:8787"
    assert not destination.exists() and not launch_agents.exists() and commands == []
    assert "test-private-api-token" not in json.dumps(result)


def test_workspace_mail_settings_preserve_private_credential_boundary(source, destination):
    module = load_installer()
    config = source / ".runtime/private/mail-settings.json"
    values = json.loads(config.read_text())
    credential = source / ".runtime/private/mail-workspace-token"
    private_write(credential, "fixture-workspace-token")
    values.update(HERALD_MAIL_WORKSPACE_URL="http://127.0.0.1:8097",
                  HERALD_MAIL_WORKSPACE_TOKEN_FILE=str(credential))
    private_write(config, json.dumps(values))
    result, copies = module.mail_settings(source, destination)
    assert result["HERALD_MAIL_WORKSPACE_URL"] == "http://127.0.0.1:8097"
    assert result["HERALD_MAIL_WORKSPACE_TOKEN_FILE"] == str(destination / "private/mail-workspace-token")
    assert (credential, destination / "private/mail-workspace-token") in copies
    assert result["HERALD_MICROSOFT365_CLIENT_ID"] == values["HERALD_MICROSOFT365_CLIENT_ID"]


def test_install_copies_owned_runtime_and_keeps_all_runtime_paths_outside_documents(
    source, destination, host
):
    module, commands, _, launch_agents = host
    result = module.install(source, destination, launch_agents)
    connection_file = destination / "connection.json"
    connection = json.loads(connection_file.read_text())
    assert connection == {
        "url": "http://127.0.0.1:8787",
        "tokenFile": str(destination / "private/api-token"),
    }
    assert connection_file.stat().st_mode & 0o777 == 0o600
    assert destination.stat().st_mode & 0o777 == 0o700
    assert (destination / "private/api-token").read_text() == "test-private-api-token\n"
    assert (destination / "private/microsoft365-msal.json").stat().st_mode & 0o777 == 0o600
    assert (destination / "lib/herald_personal/__main__.py").exists()
    assert (destination / "lib/herald_hermes/__main__.py").exists()
    plist = plistlib.loads((launch_agents / f"{module.LABEL}.plist").read_bytes())
    assert "Documents" not in json.dumps(plist)
    assert plist["EnvironmentVariables"]["HERALD_PERSONAL_MAIL_ARCHIVE_ENABLED"] == "false"
    assert plist["EnvironmentVariables"]["HERALD_PERSONAL_MAIL_DRAFT_ENABLED"] == "false"
    assert "test-private-api-token" not in json.dumps(plist)
    assert Path(plist["StandardErrorPath"]).is_relative_to(destination / "logs")
    assert "--require-hashes" in next(args for args, _ in commands if "pip" in args)
    assert any(args[:2] == ["launchctl", "bootstrap"] for args, _ in commands)
    assert result["running"] is True
    manifest = json.loads((source / ".runtime/private/installed-runtime.json").read_text())
    assert set(manifest) == {"dataDir", "tokenFile", "hermesHome", "pythonPath", "connectionFile"}
    assert all("Documents" not in value for value in manifest.values())


def test_sqlite_backup_and_reruns_preserve_target_data_rotated_token_cache_and_operator_settings(
    source, destination, host
):
    module, _, _, launch_agents = host
    module.install(source, destination, launch_agents)
    database = destination / "data/personal.sqlite3"
    with closing(sqlite3.connect(database)) as connection:
        assert (
            connection.execute("SELECT value FROM evidence WHERE id='existing'").fetchone()[0]
            == "durable"
        )
        connection.execute("INSERT INTO evidence VALUES ('target-only','preserve')")
        connection.commit()
    private_write(destination / "private/api-token", "rotated-target-token\n")
    private_write(destination / "private/microsoft365-msal.json", '{"new":"target-cache"}')
    operator = destination / "private/operator.json"
    original = json.loads(operator.read_text())
    original["operator_note"] = "preserve local settings"
    private_write(operator, json.dumps(original))
    module.install(source, destination, launch_agents)
    assert (destination / "private/api-token").read_text() == "rotated-target-token\n"
    assert json.loads((destination / "private/microsoft365-msal.json").read_text()) == {
        "new": "target-cache"
    }
    assert json.loads(operator.read_text())["operator_note"] == "preserve local settings"
    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute("SELECT COUNT(*) FROM evidence").fetchone()[0] == 2
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    assert list((destination / "backups").glob("*.sqlite3"))


def test_profile_paths_are_rewritten_without_enabling_qa_or_mail_authority(
    source, destination, host
):
    module, _, _, launch_agents = host
    module.install(source, destination, launch_agents)
    for home, role in (("hermes-home", "personal"), ("coder-home", "coder")):
        config = (destination / home / "config.yaml").read_text()
        assert str(source) not in config and "/ABSOLUTE/" not in config
        assert str(destination / ".venv/bin/python") in config
        assert str(destination / "private/api-token") in config
        assert "operator-model" in config and "qa-operator" not in config
        assert f'HERALD_MCP_ROLE: "{role}"' in config
        assert (destination / home / "skills/compromisos/SKILL.md").exists()
        assert (destination / home / "auth.json").stat().st_mode & 0o777 == 0o600
        assert not (destination / home / ".env").exists()
    operator = json.loads((destination / "private/operator.json").read_text())
    assert operator["scopes"] == {} and operator["workspaces"] == {}


def test_unowned_target_is_refused_before_any_mutation(source, destination, host):
    module, commands, _, launch_agents = host
    destination.mkdir(parents=True)
    sentinel = destination / "unrelated.txt"
    sentinel.write_text("preserve")
    with pytest.raises(ValueError, match="propiedad|pertenece|propio"):
        module.install(source, destination, launch_agents)
    assert sentinel.read_text() == "preserve" and commands == []
    assert not (destination / "private").exists()


@pytest.mark.parametrize(
    "change", ["target_symlink", "token_symlink", "public_token", "foreign_credential_path"]
)
def test_untrusted_files_are_rejected_before_processes(source, destination, host, tmp_path, change):
    module, commands, _, launch_agents = host
    token = source / ".runtime/private/api-token"
    if change == "target_symlink":
        other = tmp_path / "foreign"
        other.mkdir()
        destination.parent.mkdir(parents=True)
        destination.symlink_to(other, target_is_directory=True)
    elif change == "token_symlink":
        token.unlink()
        other = tmp_path / "foreign-token"
        private_write(other, "do not import")
        token.symlink_to(other)
    elif change == "public_token":
        token.chmod(0o644)
    else:
        settings = source / ".runtime/private/mail-settings.json"
        private_write(
            settings, json.dumps({"HERALD_MICROSOFT365_MSAL_CACHE": str(tmp_path / "foreign.json")})
        )
    with pytest.raises(ValueError):
        module.install(source, destination, launch_agents)
    assert commands == []


def test_existing_legacy_service_is_replaced_only_for_this_repository(source, destination, host):
    module, commands, loaded, launch_agents = host
    launch_agents.mkdir(parents=True)
    plist_path = launch_agents / f"{module.LABEL}.plist"
    legacy = {
        "Label": module.LABEL,
        "WorkingDirectory": str(source / "services/personal"),
        "ProgramArguments": [
            str(source / "services/personal/.venv/bin/python"),
            "-m",
            "herald_personal",
        ],
    }
    plist_path.write_bytes(plistlib.dumps(legacy))
    plist_path.chmod(0o600)
    loaded["plist"] = plist_path
    module.install(source, destination, launch_agents)
    assert [args[:2] for args, _ in commands if args[0] == "launchctl"] == [
        ["launchctl", "print"],
        ["launchctl", "bootout"],
        ["launchctl", "bootstrap"],
    ]
    assert not any(args[0] in {"kill", "killall", "pkill"} for args, _ in commands)


def test_foreign_launchagent_is_never_overwritten_or_stopped(source, destination, host):
    module, commands, _, launch_agents = host
    launch_agents.mkdir(parents=True)
    plist_path = launch_agents / f"{module.LABEL}.plist"
    foreign = {
        "Label": module.LABEL,
        "WorkingDirectory": "/unrelated/project",
        "ProgramArguments": ["/foreign/python"],
    }
    plist_path.write_bytes(plistlib.dumps(foreign))
    plist_path.chmod(0o600)
    before = plist_path.read_bytes()
    with pytest.raises(ValueError):
        module.install(source, destination, launch_agents)
    assert plist_path.read_bytes() == before and commands == [] and not destination.exists()


def test_uninstall_stops_only_owned_label_and_preserves_data_and_credentials(
    source, destination, host
):
    module, commands, _, launch_agents = host
    module.install(source, destination, launch_agents)
    commands.clear()
    token = (destination / "private/api-token").read_text()
    result = module.uninstall(source, destination, launch_agents)
    assert result["data_preserved"] is True
    assert (destination / "private/api-token").read_text() == token
    assert (destination / "data/personal.sqlite3").exists()
    assert not (launch_agents / f"{module.LABEL}.plist").exists()
    assert [args[:2] for args, _ in commands] == [["launchctl", "print"], ["launchctl", "bootout"]]


def test_failed_dependency_install_does_not_bootstrap_or_report_success(
    source, destination, host, monkeypatch
):
    module, commands, _, launch_agents = host
    original_run = module.run_command

    def fail_pip(arguments, **kwargs):
        if "pip" in arguments:
            raise subprocess.CalledProcessError(
                1, arguments, stderr="dependency installation failed"
            )
        return original_run(arguments, **kwargs)

    monkeypatch.setattr(module, "run_command", fail_pip)
    with pytest.raises((ValueError, subprocess.CalledProcessError)):
        module.install(source, destination, launch_agents)
    assert not any(args[:2] == ["launchctl", "bootstrap"] for args, _ in commands)
    assert not (source / ".runtime/private/installed-runtime.json").exists()


def test_foreign_port_is_not_killed_or_overwritten(source, destination, host, monkeypatch):
    module, commands, _, launch_agents = host
    monkeypatch.setattr(module, "port_available", lambda: False)
    with pytest.raises(ValueError, match="8787"):
        module.install(source, destination, launch_agents)
    assert not any(args[:2] == ["launchctl", "bootstrap"] for args, _ in commands)
    assert not any(args[0] in {"kill", "killall", "pkill"} for args, _ in commands)


def test_credential_ancestor_symlink_is_refused_before_installing_or_stopping_anything(
    source, destination, host, tmp_path
):
    module, commands, _, launch_agents = host
    private = source / ".runtime/private"
    private_write(private / "mail-settings.json", "{}")
    elsewhere = tmp_path / "unrelated-private"
    private.rename(elsewhere)
    private.symlink_to(elsewhere, target_is_directory=True)
    with pytest.raises(ValueError):
        module.install(source, destination, launch_agents)
    assert commands == [] and not destination.exists()


def test_launchagents_parent_permissions_are_preserved(source, destination, host):
    module, _, _, launch_agents = host
    launch_agents.mkdir(parents=True)
    launch_agents.chmod(0o755)
    module.install(source, destination, launch_agents)
    assert launch_agents.stat().st_mode & 0o777 == 0o755


def test_authentication_probe_never_follows_redirect_or_exposes_bearer(tmp_path, monkeypatch):
    module = load_installer()
    received = []

    class LocalHTTP(urllib.request.HTTPHandler):
        def http_open(self, request):
            headers = Message()
            if request.full_url.endswith("/capture"):
                received.append(request.get_header("Authorization"))
                response = urllib.response.addinfourl(
                    BytesIO(b"{}"), headers, request.full_url, 200
                )
                response.msg = "OK"
                return response
            headers["Location"] = "http://127.0.0.1:8787/capture"
            response = urllib.response.addinfourl(BytesIO(b""), headers, request.full_url, 302)
            response.msg = "Found"
            return response

    original_builder = urllib.request.build_opener
    monkeypatch.setattr(
        module.urllib.request,
        "build_opener",
        lambda *handlers: original_builder(LocalHTTP(), *handlers),
    )
    private_write(tmp_path / "private/api-token", "test-only-bearer")
    fake_clock(module, monkeypatch)
    assert module.wait_ready(tmp_path) is False
    assert received == []


@pytest.mark.parametrize("ready_after", [12.0, None])
def test_authentication_probe_allows_cold_start_and_obeys_deadline(
    tmp_path, monkeypatch, ready_after
):
    module = load_installer()
    elapsed = fake_clock(module, monkeypatch)
    private_write(tmp_path / "private/api-token", "test-only-bearer")

    def open_response(request, *, timeout):
        assert 0 < timeout <= 1
        assert request.full_url == "http://127.0.0.1:8787/v1/status"
        if ready_after is None or elapsed[0] < ready_after:
            raise ConnectionRefusedError("Service is still starting")
        return urllib.response.addinfourl(BytesIO(b"{}"), Message(), request.full_url, 200)

    monkeypatch.setattr(
        module.urllib.request, "build_opener", lambda *handlers: SimpleNamespace(open=open_response)
    )
    assert module.wait_ready(tmp_path) is (ready_after is not None)
    if ready_after is None:
        assert 60 <= elapsed[0] <= 61
    else:
        assert ready_after <= elapsed[0] < 60
