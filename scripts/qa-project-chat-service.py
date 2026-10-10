#!/usr/bin/env python3
"""Disposable project chat API fixture; never connects external providers."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/personal"))

import uvicorn
from herald_personal.api import create_app
from herald_personal.config import Settings

if __name__ == "__main__":
    qa = ROOT / ".runtime/qa-project-chat"
    settings = Settings(
        data_dir=qa / "data", api_token_file=qa / "token", requests_per_minute=2000
    )
    uvicorn.run(
        create_app(settings),
        host="127.0.0.1",
        port=8797,
        log_level="warning",
        access_log=False,
    )
