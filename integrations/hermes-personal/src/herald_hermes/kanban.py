"""Only the supported Hermes CLI, pinned to an isolated operator-chosen home."""

import json
import os
import re
import subprocess
from pathlib import Path


class KanbanError(ValueError):
    pass


class KanbanClient:
    def __init__(self, executable, hermes_home, board, *, allow_create=False):
        self.executable = str(Path(executable).expanduser().absolute())
        self.home = Path(hermes_home).expanduser().resolve()
        global_home = (Path.home() / ".hermes").resolve()
        if self.home == global_home or global_home in self.home.parents:
            raise KanbanError("Configure un HERMES_HOME aislado, fuera de ~/.hermes.")
        if not Path(self.executable).is_file() or not os.access(
            self.executable, os.X_OK
        ):
            raise KanbanError("Ejecutable Hermes no disponible.")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", board):
            raise KanbanError("Slug de tablero inválido.")
        self.board, self.allow_create = board, allow_create

    @staticmethod
    def _id(value):
        if not isinstance(value, str) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value
        ):
            raise KanbanError("ID de tarjeta inválido.")
        return value

    def _run(self, arguments):
        env = {
            key: value
            for key, value in os.environ.items()
            if key in {"PATH", "HOME", "USER", "LANG", "TMPDIR"}
        }
        env.update(HERMES_HOME=str(self.home), HERMES_KANBAN_DISPATCH_IN_GATEWAY="0")
        try:
            result = subprocess.run(
                [
                    self.executable,
                    "kanban",
                    "--board",
                    self.board,
                    *arguments,
                    "--json",
                ],
                env=env,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
                shell=False,
            )
            if result.returncode != 0 or len(result.stdout) > 1_000_000:
                raise KanbanError(
                    "CLI Kanban falló; revisar configuración aislada del operador."
                )
            return json.loads(result.stdout)
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            raise KanbanError(
                "Kanban no disponible o respuesta JSON inválida."
            ) from None

    def list(self):
        return self._run(["list"])

    def show(self, task_id):
        return self._run(["show", self._id(task_id)])

    def create(self, title, run_id, *, confirmed=False):
        if not self.allow_create or confirmed is not True:
            raise KanbanError(
                "Crear tarjeta requiere capacidad del operador y confirmación humana."
            )
        if (
            not isinstance(title, str)
            or not title.strip()
            or title.startswith("-")
            or len(title) > 500
        ):
            raise KanbanError("Título inválido.")
        run_id = self._id(run_id)
        return self._run(
            [
                "create",
                title,
                "--initial-status",
                "blocked",
                "--idempotency-key",
                "herald-" + run_id,
                "--created-by",
                "herald-personal",
                "--body",
                "Ejecución Herald: "
                + run_id
                + ". Requiere revisión humana; no despachar.",
            ]
        )
