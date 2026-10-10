#!/usr/bin/env python3
"""Isolated personal API for native project dashboard QA. No external sources."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/personal"))

import uvicorn  # noqa: E402

from herald_personal.api import create_app  # noqa: E402
from herald_personal.config import Settings  # noqa: E402

if __name__ == "__main__":
    qa = ROOT / ".runtime/qa-projects"
    settings = Settings(data_dir=qa / "data", api_token_file=qa / "token", requests_per_minute=1000)
    uvicorn.run(create_app(settings), host="127.0.0.1", port=8796, log_level="warning", access_log=False)
