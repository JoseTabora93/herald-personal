"""Native desktop uses the existing mail authority without gaining provider write powers."""

import json

import httpx
import pytest
from test_mail_workspace import workspace_client


@pytest.mark.parametrize(
    "action,params",
    [
        ("mail-rezagados", {"limite": 25, "desplazamiento": 50}),
        ("mail-backfill-estado", {}),
        ("mail-lotes-estado", {"limite": 12}),
    ],
)
def test_native_views_read_existing_source(settings, action, params):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"items": [], "total": 0})

    with workspace_client(settings, handler) as client:
        assert (
            client.post(
                "/v1/mail-workspace/query", json={"action": action, "params": params}
            ).status_code
            == 200
        )
    assert len(seen) == 1 and seen[0].method == "GET"


@pytest.mark.parametrize(
    "action,params",
    [
        ("mail-update-item", {"id": "MAIL-12", "estado": "agendado"}),
        ("mail-compose-open", {"modo": "responder", "clave": "MAIL-12"}),
        (
            "mail-compose-save",
            {
                "id": "compose-1",
                "cuerpoMd": "Borrador [confirmar: fecha]",
                "para": [{"nombre": "Persona", "direccion": "persona@example.test"}],
            },
        ),
        ("mail-draft-version", {"id": "MAIL-12", "hacia": "anterior", "composeId": "compose-1"}),
    ],
)
def test_local_edits_use_explicit_contract_and_never_impersonate_browser(settings, action, params):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"id": "compose-1", "guardado": True})

    with workspace_client(settings, handler) as client:
        result = client.post("/v1/mail-workspace/local", json={"action": action, "params": params})
        assert result.status_code == 200
    assert len(seen) == 1 and seen[0].method == "POST"
    assert seen[0].url.path.endswith(action)
    assert json.loads(seen[0].content).items() >= params.items()
    assert "x-agent-native-frontend" not in seen[0].headers
    assert "cookie" not in seen[0].headers


@pytest.mark.parametrize(
    "action",
    [
        "mail-send-confirm",
        "mail-send-prepare",
        "mail-outlook-save",
        "mail-limpieza-aplicar",
        "mail-aprendizaje-decidir",
        "mail-compose-discard",
        "mail-sync",
        "../../admin",
    ],
)
def test_native_bridge_never_exposes_provider_writes_or_approvals(settings, action):
    seen = []
    with workspace_client(settings, lambda request: seen.append(request)) as client:
        assert (
            client.post(
                "/v1/mail-workspace/local", json={"action": action, "params": {}}
            ).status_code
            == 422
        )
    assert not seen


@pytest.mark.parametrize(
    "params",
    [
        {"id": "../escape", "estado": "hecho"},
        {"id": "MAIL-1", "estado": "hecho", "url": "https://bad.example"},
        {"id": "MAIL-1", "estado": "invalid"},
    ],
)
def test_local_validation_fails_before_network(settings, params):
    seen = []
    with workspace_client(settings, lambda request: seen.append(request)) as client:
        assert (
            client.post(
                "/v1/mail-workspace/local", json={"action": "mail-update-item", "params": params}
            ).status_code
            == 422
        )
    assert not seen


def test_native_local_route_requires_auth_and_does_not_retry_or_leak_errors(settings):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(500, json={"error": "upstream-private-secret"})

    with workspace_client(settings, handler) as client:
        client.headers.pop("Authorization")
        assert (
            client.post(
                "/v1/mail-workspace/local", json={"action": "mail-compose-open"}
            ).status_code
            == 401
        )
        client.headers["Authorization"] = "Bearer test-local-bearer"
        response = client.post(
            "/v1/mail-workspace/local",
            json={"action": "mail-compose-open", "params": {"modo": "nuevo"}},
        )
        assert response.status_code == 502
        assert "upstream-private-secret" not in response.text
    assert len(seen) == 1


def test_compose_read_uses_get_without_expanding_agent_read_catalog(settings):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"id": "compose-1"})

    with workspace_client(settings, handler) as client:
        assert (
            client.post(
                "/v1/mail-workspace/local",
                json={"action": "mail-compose-get", "params": {"id": "compose-1"}},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/v1/mail-workspace/query",
                json={"action": "mail-compose-get", "params": {"id": "compose-1"}},
            ).status_code
            == 422
        )
    assert len(seen) == 1 and seen[0].method == "GET"
