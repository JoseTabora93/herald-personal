#!/usr/bin/env python3
"""Private local runtime. No global Hermes configuration or account login is modified."""
import argparse
import json
import os
import secrets
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

MAIL_KEYS = {
    'HERALD_MICROSOFT365_MSAL_CACHE', 'HERALD_MICROSOFT365_CLIENT_ID',
    'HERALD_MICROSOFT365_TENANT_ID', 'HERALD_MICROSOFT365_TOKEN_FILE',
    'HERALD_GMAIL_TOKEN_FILE',
}


def private_file(path: Path) -> None:
    metadata = path.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077
            or metadata.st_uid != os.getuid()):
        raise ValueError('La configuración y las credenciales requieren archivo propio con permisos 0600.')


def private_json(path: Path) -> dict:
    private_file(path)
    if path.stat().st_size > 32_000:
        raise ValueError('La configuración personal excede su límite.')
    values = json.loads(path.read_text())
    if not isinstance(values, dict):
        raise ValueError('La configuración personal no es un objeto válido.')
    return values


def installed_runtime(root: Path) -> Path | None:
    manifest = root / '.runtime/private/installed-runtime.json'
    if not manifest.exists() and not manifest.is_symlink():
        return None
    values = private_json(manifest)
    names = {'dataDir': 'data', 'tokenFile': 'private/api-token', 'hermesHome': 'hermes-home',
             'pythonPath': '.venv/bin/python', 'connectionFile': 'connection.json'}
    if set(values) != set(names) or any(
        not isinstance(value, str) or any(c in value for c in '\x00\r\n') or not Path(value).is_absolute()
        for value in values.values()
    ):
        raise ValueError('El manifiesto instalado contiene rutas inválidas.')
    target = Path(values['connectionFile']).parent
    if any(values[key] != str(target / suffix) for key, suffix in names.items()):
        raise ValueError('Las rutas instaladas no corresponden a una misma instancia.')
    if target.is_symlink() or any(parent.is_symlink() for parent in target.parents):
        raise ValueError('La instalación no puede usar directorios simbólicos.')
    connection = private_json(target / 'connection.json')
    if connection != {'url': 'http://127.0.0.1:8787', 'tokenFile': values['tokenFile']}:
        raise ValueError('La conexión instalada no corresponde al servicio local privado.')
    private_file(target / 'private/api-token')
    return target


def runtime_python(root: Path, env: dict[str, str]) -> Path:
    return Path(env.get('HERALD_PERSONAL_PYTHON', str(root / 'services/personal/.venv/bin/python')))


def prepare_runtime(root: Path) -> dict[str, str]:
    root = root.resolve()
    installed = installed_runtime(root)
    runtime = installed or root / '.runtime'
    for directory in (runtime, runtime / 'private', runtime / 'data', runtime / 'logs', runtime / 'hermes-home'):
        if directory.is_symlink():
            raise ValueError('El directorio personal no puede ser un enlace simbólico.')
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory.chmod(0o700)
    token = runtime / 'private' / 'api-token'
    if not token.exists() and not token.is_symlink():
        fd = os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(secrets.token_urlsafe(48) + '\n')
    private_file(token)
    env = {
        'HERALD_PERSONAL_URL': 'http://127.0.0.1:8787',
        'HERALD_PERSONAL_TOKEN_FILE': str(token),
        'HERALD_PERSONAL_DATA_DIR': str(runtime / 'data'),
        'HERALD_PERSONAL_MAIL_DRAFT_ENABLED': 'false',
        'HERALD_PERSONAL_MAIL_ARCHIVE_ENABLED': 'false',
        'HERMES_HOME': str(runtime / 'hermes-home'),
        'HERALD_OS_HERMES_ROOT': str(Path.home() / '.hermes/hermes-agent'),
        'PYTHONPATH': os.pathsep.join([str(root / 'services/personal'), str(root / 'integrations/hermes-personal/src')]),
        'HERALD_PERSONAL_LOG_DIR': str(runtime / 'logs'),
        'TZ': 'America/Tegucigalpa',
    }
    if installed is not None:
        env['PYTHONPATH'] = str(installed / 'lib')
        env['HERALD_PERSONAL_PYTHON'] = str(installed / '.venv/bin/python')
    settings = runtime / 'private/mail-settings.json'
    if settings.exists() or settings.is_symlink():
        values = private_json(settings)
        if not values.keys() <= MAIL_KEYS:
            raise ValueError('La configuración contiene campos no permitidos.')
        if any(not isinstance(value, str) or '\n' in value or '\r' in value for value in values.values()):
            raise ValueError('La configuración personal contiene valores inválidos.')
        env.update(values)
    return env


def diagnostics(root: Path, env: dict[str, str]) -> dict[str, object]:
    return {
        'python_installed': runtime_python(root, env).exists(),
        'desktop_built': (root / 'apps/desktop/dist/electron/main.mjs').exists(),
        'credential_file_configured': bool(env.get('HERALD_PERSONAL_TOKEN_FILE')),
        'microsoft365_configured': bool(env.get('HERALD_MICROSOFT365_MSAL_CACHE') or env.get('HERALD_MICROSOFT365_TOKEN_FILE')),
        'gmail_configured': bool(env.get('HERALD_GMAIL_TOKEN_FILE')),
        'mail_draft_enabled': env.get('HERALD_PERSONAL_MAIL_DRAFT_ENABLED') == 'true',
        'mail_archive_enabled': env.get('HERALD_PERSONAL_MAIL_ARCHIVE_ENABLED') == 'true',
        'always_on_cloud': False,
        'whatsapp_destination_configured': False,
    }


def service_ready(env: dict[str, str]) -> bool:
    # Loopback is fixed by prepare_runtime, so no credentials can leave this host.
    request = urllib.request.Request(env['HERALD_PERSONAL_URL'] + '/v1/status', headers={
        'Authorization': 'Bearer ' + Path(env['HERALD_PERSONAL_TOKEN_FILE']).read_text().strip()
    })
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=2) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description='Herald Personal: entorno local privado')
    parser.add_argument('action', choices=['init', 'service', 'desktop', 'doctor', 'launchagent'])
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if args.action == 'launchagent':
        if sys.platform != 'darwin':
            raise ValueError('Usa el servicio systemd documentado para Linux.')
        return subprocess.call([sys.executable, str(root / 'scripts/install-personal-macos.py'), 'install'])
    settings = prepare_runtime(root)
    env = {**os.environ, **settings}
    env.pop('HERALD_PERSONAL_TOKEN', None)
    python = runtime_python(root, settings)
    command = [str(python), '-m', 'herald_personal', '--host', '127.0.0.1', '--port', '8787']
    if args.action == 'init':
        print('Entorno personal preparado. Credenciales privadas; escrituras de correo desactivadas.')
        return 0
    if args.action == 'doctor':
        report = diagnostics(root, settings)
        report['service_authenticated'] = service_ready(settings)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    if not python.exists():
        raise ValueError('Instala las dependencias con bash scripts/setup-personal.sh.')
    if args.action == 'service':
        os.execve(python, command, env)
    if not diagnostics(root, settings)['desktop_built']:
        raise ValueError('Compila la aplicación con npm run build.')
    child = None
    log = None
    if not service_ready(settings):
        logfile = Path(settings['HERALD_PERSONAL_LOG_DIR']) / 'service.log'
        fd = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        log = os.fdopen(fd, 'a')
        child = subprocess.Popen(command, cwd=root / 'services/personal', env=env, stdout=log, stderr=log)
        for _ in range(40):
            if service_ready(settings):
                break
            if child.poll() is not None:
                raise ValueError('El servicio no inició. Revisa .runtime/logs/service.log.')
            time.sleep(0.25)
        else:
            child.terminate()
            child.wait(timeout=5)
            raise ValueError('El servicio personal no respondió.')
    try:
        return subprocess.call(['node', str(root / 'node_modules/electron/cli.js'), str(root / 'apps/desktop')], env=env)
    finally:
        if child is not None:
            child.terminate()
            child.wait(timeout=10)
        if log is not None:
            log.close()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
