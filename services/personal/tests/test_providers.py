import base64
import json

import httpx
import pytest
from test_mail import gmail_message, graph_message

from herald_personal.providers.base import ProviderError
from herald_personal.providers.gmail import GmailProvider
from herald_personal.providers.graph import GraphProvider


def test_graph_pages_are_bounded_and_resume_from_last_durable_page():
    calls = []

    def handler(request):
        calls.append(request)
        page = len(calls)
        return httpx.Response(
            200,
            json={
                "value": [graph_message(f"remote-{page}")],
                "@odata.nextLink": f"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken={page}",
            },
        )

    provider = GraphProvider(
        "token", client=httpx.Client(transport=httpx.MockTransport(handler)), max_pages=2
    )
    first = provider.sync(None)
    assert len(calls) == 2 and len(first.messages) == 2
    assert first.cursor.endswith("$skiptoken=2")
    second = provider.sync(first.cursor)
    assert "$skiptoken=2" in str(calls[2].url) and len(second.messages) == 2


@pytest.mark.parametrize("status", [401, 403, 429, 500])
def test_provider_failures_use_sanitized_actionable_errors(status):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(status, json={"error": "TOKEN-secret and private message"})

    provider = GraphProvider(
        "TOKEN-secret", client=httpx.Client(transport=httpx.MockTransport(handler)), retry_delay=0
    )
    with pytest.raises(ProviderError) as failure:
        provider.sync(None)
    assert "TOKEN-secret" not in str(failure.value) and "private message" not in str(failure.value)
    assert 1 <= len(requests) <= 3
    if status in {401, 403}:
        assert len(requests) == 1


def test_gmail_draft_is_reply_mime_and_does_not_use_send_endpoint():
    writes = []

    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json=gmail_message())
        writes.append(request)
        value = json.loads(request.content)
        mime = base64.urlsafe_b64decode(value["message"]["raw"]).decode()
        assert "In-Reply-To: <message@example.test>" in mime
        assert "To: supplier@example.test" in mime
        assert "Mañana" in mime or "Ma=C3=B1ana" in mime
        assert value["message"]["threadId"] == "conversation-1"
        return httpx.Response(200, json={"id": "draft-1", "message": {"id": "draft-message"}})

    provider = GmailProvider("token", client=httpx.Client(transport=httpx.MockTransport(handler)))
    result = provider.create_draft("gm-1", "Mañana")
    assert result.id == "draft-1"
    assert [r.url.path for r in writes] == ["/gmail/v1/users/me/drafts"]


def test_gmail_archive_and_undo_preserve_unrelated_label_changes():
    labels = ["INBOX", "UNREAD", "project-label"]
    writes = []

    def handler(request):
        if request.method == "POST":
            payload = json.loads(request.content)
            writes.append(payload)
            for label in payload.get("removeLabelIds", []):
                if label in labels:
                    labels.remove(label)
            labels.extend(label for label in payload.get("addLabelIds", []) if label not in labels)
        return httpx.Response(200, json=gmail_message(labels=labels.copy()))

    provider = GmailProvider("token", client=httpx.Client(transport=httpx.MockTransport(handler)))
    previous = provider.inspect("gm-1")
    result = provider.archive("gm-1", previous)
    assert "INBOX" not in labels
    labels.append("new-label")
    restored = provider.restore(result.provider_id, previous, result.location)
    assert restored.provider_id == "gm-1"
    assert labels == ["UNREAD", "project-label", "new-label", "INBOX"]
    assert writes == [{"removeLabelIds": ["INBOX"]}, {"addLabelIds": ["INBOX"]}]


def test_gmail_full_sync_can_continue_across_pages_without_advancing_history_early():
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path.endswith("/profile"):
            return httpx.Response(200, json={"historyId": "100"})
        if request.url.path.endswith("/messages"):
            if "pageToken" not in request.url.params:
                return httpx.Response(
                    200, json={"messages": [{"id": "gm-1"}], "nextPageToken": "second"}
                )
            assert request.url.params["pageToken"] == "second"
            return httpx.Response(200, json={"messages": [{"id": "gm-2"}]})
        return httpx.Response(200, json=gmail_message(request.url.path.rsplit("/", 1)[-1]))

    provider = GmailProvider(
        "token", client=httpx.Client(transport=httpx.MockTransport(handler)), max_pages=1
    )
    first = provider.sync(None)
    assert [m.provider_id for m in first.messages] == ["gm-1"]
    second = provider.sync(first.cursor)
    assert [m.provider_id for m in second.messages] == ["gm-2"]
    assert json.loads(second.cursor)["history_id"] == "100"
    assert second.snapshot_ids == ["gm-1", "gm-2"]
    assert sum(r.url.path.endswith("/profile") for r in calls) == 1


def test_graph_rejects_malformed_data_and_message_ids_are_encoded():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(200, json={"unexpected": "shape"})

    provider = GraphProvider("token", client=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(ProviderError):
        provider.sync(None)
    with pytest.raises(ProviderError):
        provider.inspect("foreign/id?query=1")
    assert "foreign%2Fid%3Fquery%3D1" in seen[-1]


def test_graph_accepts_official_odata_quoted_inbox_continuation():
    calls = []
    quoted = "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta"

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(
                200,
                json={"value": [graph_message()], "@odata.nextLink": quoted + "?$skiptoken=next"},
            )
        assert request.url.path == "/v1.0/me/mailFolders('inbox')/messages/delta"
        return httpx.Response(
            200, json={"value": [], "@odata.deltaLink": quoted + "?$deltatoken=last"}
        )

    provider = GraphProvider("token", client=httpx.Client(transport=httpx.MockTransport(handler)))
    result = provider.sync(None)
    assert len(calls) == 2 and len(result.messages) == 1
    assert result.cursor == quoted + "?$deltatoken=last"


@pytest.mark.parametrize(
    "path",
    [
        "/v1.0/me/mailFolders('sentitems')/messages/delta",
        "/v1.0/me/mailFolders('inbox')/messages",
        "/v1.0/users/someone/messages/delta",
    ],
)
def test_graph_quoted_inbox_exception_does_not_allow_other_resources(path):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            200, json={"value": [], "@odata.nextLink": "https://graph.microsoft.com" + path}
        )

    provider = GraphProvider("token", client=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(ProviderError):
        provider.sync(None)
    assert len(calls) == 1
