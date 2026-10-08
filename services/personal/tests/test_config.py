import os

import pytest
from fastapi.testclient import TestClient

from herald_personal.api import create_app
from herald_personal.config import Settings


def test_token_file_rotation_does_not_expose_credentials(tmp_path, monkeypatch):
    path = tmp_path / "api-token"
    path.write_text("first-token")
    path.chmod(0o600)
    monkeypatch.delenv("HERALD_PERSONAL_TOKEN", raising=False)
    monkeypatch.setenv("HERALD_PERSONAL_TOKEN_FILE", str(path))
    monkeypatch.setenv("HERALD_PERSONAL_DATA_DIR", str(tmp_path / "state"))
    settings = Settings.from_env()
    with TestClient(create_app(settings)) as client:
        assert (
            client.get("/v1/status", headers={"Authorization": "Bearer first-token"}).status_code
            == 200
        )
        path.write_text("second-token")
        assert (
            client.get("/v1/status", headers={"Authorization": "Bearer first-token"}).status_code
            == 401
        )
        response = client.get("/v1/status", headers={"Authorization": "Bearer second-token"})
        assert response.status_code == 200 and "second-token" not in response.text
        assert "first-token" not in repr(settings)
    assert os.stat(settings.data_dir / "personal.sqlite3").st_mode & 0o077 == 0


@pytest.mark.parametrize("content", ["", "token\nsecond", '{"access_token": ""}'])
def test_invalid_token_file_fails_closed(tmp_path, monkeypatch, content):
    path = tmp_path / "token"
    path.write_text(content)
    path.chmod(0o600)
    monkeypatch.delenv("HERALD_PERSONAL_TOKEN", raising=False)
    monkeypatch.setenv("HERALD_PERSONAL_TOKEN_FILE", str(path))
    monkeypatch.setenv("HERALD_PERSONAL_DATA_DIR", str(tmp_path / "state"))
    with TestClient(create_app(Settings.from_env())) as client:
        assert client.get("/v1/tasks", headers={"Authorization": "Bearer token"}).status_code == 503
