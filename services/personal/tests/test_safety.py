import json
import sqlite3
from contextlib import closing

import httpx
import pytest
from fastapi.testclient import TestClient
from test_mail import client_with_provider, graph_message

from herald_personal.api import create_app
from herald_personal.database import SCHEMA, Database
from herald_personal.providers.base import ProviderError, safe_web_url
from herald_personal.providers.graph import GraphProvider


def test_successful_but_malformed_draft_response_blocks_retry_after_restart(settings):
    settings = settings.model_copy(update={"mail_draft_enabled": True})
    writes = []

    def handler(request):
        if request.method == "POST":
            writes.append(request)
            return httpx.Response(201, json={"isDraft": True})
        return httpx.Response(
            200,
            json={
                "value": [graph_message()],
                "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=1",
            },
        )

    provider = GraphProvider(
        "test-token", client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    with client_with_provider(settings, "microsoft365", provider) as client:
        client.post("/v1/mail/sync", json={"provider": "microsoft365"})
        identifier = client.get("/v1/mail/threads").json()["items"][0]["id"]
        assert (
            client.post(
                f"/v1/mail/threads/{identifier}/draft", json={"body": "Revisaré"}
            ).status_code
            == 502
        )
    with client_with_provider(settings, "microsoft365", provider) as restarted:
        assert (
            restarted.post(
                f"/v1/mail/threads/{identifier}/draft", json={"body": "Revisaré"}
            ).status_code
            == 409
        )
    assert len(writes) == 1


@pytest.mark.parametrize(
    "value", [123, {}, "javascript:alert(1)", "https://outlook.office.com@attacker.test/x"]
)
def test_untrusted_web_links_never_become_active_urls(value):
    assert safe_web_url(value, {"outlook.office.com"}) is None


def test_untrusted_html_script_style_and_external_images_are_plain_text():
    from herald_personal.providers.base import plain_text

    result = plain_text(
        "<style>hidden</style><p>Hola</p><iframe>evil</iframe><img src='https://x'>", True
    )
    assert result == "Hola"


def test_request_size_and_rate_limits_are_enforced(settings):
    with TestClient(create_app(settings)) as client:
        client.headers["Authorization"] = "Bearer test-local-bearer"
        assert client.post("/v1/tasks", content="x" * 256_001).status_code == 413
    settings = settings.model_copy(update={"requests_per_minute": 2})
    with TestClient(create_app(settings)) as client:
        client.headers["Authorization"] = "Bearer test-local-bearer"
        assert client.get("/v1/tasks").status_code == 200
        assert client.get("/v1/checkins").status_code == 200
        assert client.get("/v1/status").status_code == 429


def test_v1_database_migrates_without_losing_human_records(tmp_path):
    database_path = tmp_path / "personal.sqlite3"
    with closing(sqlite3.connect(database_path)) as connection:
        connection.executescript(SCHEMA + "PRAGMA user_version=1;")
        connection.execute(
            "INSERT INTO checkins VALUES (?,?,?,?,?,?,?)",
            (
                "checkin-old",
                "2026-10-08",
                "Entrega",
                "Pendiente",
                "Revisión",
                "2026-10-08T00:00:00Z",
                "2026-10-08T00:00:00Z",
            ),
        )
        connection.commit()
    database = Database(tmp_path)
    with database.connection() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
        assert connection.execute("SELECT id FROM checkins").fetchone()[0] == "checkin-old"
        assert connection.execute("SELECT COUNT(*) FROM agent_runs").fetchone()[0] == 0


def test_provider_invalid_json_and_foreign_redirects_are_errors_without_writes():
    for response in [
        httpx.Response(200, content=b"not-json"),
        httpx.Response(302, headers={"Location": "https://evil.test"}),
    ]:
        calls = []

        def handler(request, calls=calls, response=response):
            calls.append(request)
            return response

        provider = GraphProvider(
            "test-token", client=httpx.Client(transport=httpx.MockTransport(handler))
        )
        with pytest.raises(ProviderError):
            provider.sync(None)
        assert len(calls) == 1


def test_graph_mutation_is_verified_and_mismatch_is_uncertain():
    writes = []

    def handler(request):
        if request.url.path.endswith("/mailFolders/archive"):
            return httpx.Response(200, json={"id": "archive-id"})
        if request.method == "POST":
            writes.append(json.loads(request.content))
            return httpx.Response(201, json=graph_message(parentFolderId="archive-id"))
        return httpx.Response(200, json=graph_message(parentFolderId="another-folder"))

    provider = GraphProvider(
        "test-token", client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    with pytest.raises(ProviderError) as result:
        provider.archive("remote-1", {"folder_id": "inbox-id"})
    assert result.value.uncertain is True
    assert len(writes) == 1
