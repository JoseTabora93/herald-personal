from fastapi.testclient import TestClient


def test_service_boots_fail_closed_without_credentials(tmp_path):
    from herald_personal.api import create_app
    from herald_personal.config import Settings

    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
        assert client.get("/v1/tasks").status_code == 503
