#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
command -v uv >/dev/null || { echo "Instala uv antes de continuar." >&2; exit 1; }
uv venv services/personal/.venv --python 3.13 --allow-existing
uv pip install --python services/personal/.venv/bin/python --require-hashes -r services/personal/requirements.lock
python3 scripts/personal_runtime.py init
echo "Servicio: npm run personal:service | Escritorio: npm run personal:desktop"
