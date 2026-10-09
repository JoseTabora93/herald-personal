"""Bounded local commands and private operator configuration; no shell expansion."""

from __future__ import annotations

import json
import os
import selectors
import signal
import stat
import subprocess
import tempfile
import time
from pathlib import Path


class RuntimeErrorSafe(ValueError):
    pass


def private_json(path, *, maximum=65536):
    """Read an owner-only regular file, without following a final symlink."""
    descriptor = os.open(Path(path).expanduser(), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_size > maximum
        ):
            raise RuntimeErrorSafe(
                "Se requiere un archivo privado del usuario, de tamaño acotado."
            )
        payload = json.loads(stream.read(maximum + 1))
    if not isinstance(payload, dict):
        raise RuntimeErrorSafe("La configuración debe ser un objeto JSON.")
    return payload


def bounded_run(argv, *, timeout=10, input_text=None, env=None, maximum=1048576):
    """Only children created here may be signalled; output and wall time are bounded."""
    if (
        not isinstance(argv, list)
        or not argv
        or not Path(argv[0]).is_absolute()
        or any(not isinstance(arg, str) or "\0" in arg for arg in argv)
    ):
        raise RuntimeErrorSafe("Comando local inválido.")
    if not 0 < timeout <= 120 or not 1 <= maximum <= 2_000_000:
        raise RuntimeErrorSafe("Presupuesto de ejecución inválido.")
    child_env = {
        k: v
        for k, v in os.environ.items()
        if k
        in {
            "HOME",
            "PATH",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        }
    }
    child_env.update({"NO_COLOR": "1", "PYTHONDONTWRITEBYTECODE": "1"})
    if env:
        if set(env) - {"HERMES_HOME", "HERMES_TIMEZONE"}:
            raise RuntimeErrorSafe("Variables no permitidas para el proceso local.")
        child_env.update(env)
    encoded = (input_text or "").encode("utf-8")
    if len(encoded) > 32768:
        raise RuntimeErrorSafe("La entrada excede el presupuesto local.")
    with tempfile.TemporaryFile() as stdin, selectors.DefaultSelector() as selector:
        stdin.write(encoded)
        stdin.seek(0)
        proc = subprocess.Popen(
            argv,
            stdin=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=child_env,
            start_new_session=True,
            shell=False,
        )
        output, total = bytearray(), 0
        deadline = time.monotonic() + timeout
        needs_cleanup = True
        try:
            selector.register(proc.stdout, selectors.EVENT_READ, True)
            selector.register(proc.stderr, selectors.EVENT_READ, False)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise TimeoutError("El proceso local agotó su presupuesto.")
                for key, _ in selector.select(
                    min(0.05, max(0, deadline - time.monotonic()))
                ):
                    chunk = os.read(key.fd, 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    total += len(chunk)
                    if total > maximum:
                        raise RuntimeErrorSafe("La salida excede el presupuesto local.")
                    if key.data:
                        output.extend(chunk)
            code = proc.wait(timeout=max(0.01, deadline - time.monotonic()))
            needs_cleanup = False
            if code:
                raise RuntimeErrorSafe("El proceso local informó un error.")
            return output.decode("utf-8")
        finally:
            # This process group was created above, never discovered from user sessions.
            if needs_cleanup:
                # Do not reap the leader before signalling its group. An exited
                # leader remains our child, reserving the ID while descendants
                # may still hold the output pipes. Never use a persisted PID.
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                else:
                    time.sleep(0.1)
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        # Darwin returns EPERM when only the unreaped dead
                        # leader remains. wait below still verifies child exit.
                        pass
                proc.wait(timeout=1)
            proc.stdout.close()
            proc.stderr.close()
