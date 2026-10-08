from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from fastapi.testclient import TestClient

if TYPE_CHECKING:
    from herald_personal.config import Settings


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    from herald_personal.config import Settings

    return Settings(data_dir=tmp_path, api_token="test-local-bearer")


@pytest.fixture
def client(settings: Settings):
    from herald_personal.api import create_app

    with TestClient(create_app(settings)) as active:
        active.headers["Authorization"] = "Bearer test-local-bearer"
        yield active
