"""Paginate real persisted messages without truncating content or exceeding IPC bounds."""

import sqlite3
from contextlib import closing

import pytest


@pytest.fixture
def large_mailbox(client, settings):
    body = '📨é\\"\n' * 10_000
    assert len(body) == 50_000
    with closing(sqlite3.connect(settings.data_dir / "personal.sqlite3")) as connection:
        connection.executemany(
            "INSERT INTO mail(id,provider,provider_id,subject,sender,preview,body,"
            "received_at,category,unread,archived,location) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                (
                    f"mail-{number:03d}",
                    "microsoft365",
                    f"remote-{number:03d}",
                    "Revisión 100% prevista" if number % 3 == 0 else f"Seguimiento {number}",
                    "supplier@example.test",
                    "Revisar la propuesta",
                    body,
                    "2026-10-09T12:00:00Z" if number >= 30 else "2026-10-08T12:00:00Z",
                    "urgent" if number % 2 == 0 else "action",
                    1,
                    int(number == 0),
                    "{}",
                )
                for number in range(60)
            ],
        )
        connection.commit()
    ordered = [f"mail-{number:03d}" for number in [*range(30, 60), *range(30)]]
    return client, body, ordered


def test_large_mail_pages_stay_bounded_preserve_bodies_and_make_progress(large_mailbox):
    client, body, ordered = large_mailbox
    seen = []
    offset = 0
    for _ in range(60):
        response = client.get("/v1/mail/threads", params={"offset": offset})
        assert response.status_code == 200
        assert len(response.content) <= 1024 * 1024
        page = response.json()
        assert page["offset"] == offset and page["total"] == 60
        assert isinstance(page["providers"], list)
        assert 1 <= len(page["items"]) <= 50
        assert all(item["body"] == body for item in page["items"])
        seen.extend(item["id"] for item in page["items"])
        if page["next_offset"] is None:
            break
        assert page["next_offset"] == offset + len(page["items"])
        offset = page["next_offset"]
    else:
        pytest.fail("Mailbox pagination did not terminate")
    assert seen == ordered
    assert len(set(seen)) == 60


def test_mail_page_limit_offset_and_filtered_total_apply_together(large_mailbox):
    client, _, ordered = large_mailbox
    page = client.get("/v1/mail/threads", params={"limit": 2, "offset": 1}).json()
    assert [item["id"] for item in page["items"]] == ordered[1:3]
    assert page["total"] == 60 and page["offset"] == 1 and page["next_offset"] == 3

    filtered = [identifier for identifier in ordered if int(identifier[5:]) % 6 == 0]
    parameters = {"category": "urgent", "q": "100%", "limit": 3, "offset": 0}
    page = client.get("/v1/mail/threads", params=parameters).json()
    assert [item["id"] for item in page["items"]] == filtered[:3]
    assert page["total"] == 10 and page["next_offset"] == 3
    parameters["offset"] = 9
    last = client.get("/v1/mail/threads", params=parameters).json()
    assert [item["id"] for item in last["items"]] == filtered[9:]
    assert last["total"] == 10 and last["next_offset"] is None


def test_empty_mail_pages_preserve_total_and_return_no_next_offset(large_mailbox):
    client, _, _ = large_mailbox
    empty = client.get("/v1/mail/threads", params={"q": "No coincide"}).json()
    assert empty["items"] == [] and empty["total"] == 0 and empty["next_offset"] is None
    beyond = client.get("/v1/mail/threads", params={"offset": 100_000}).json()
    assert beyond["items"] == [] and beyond["total"] == 60
    assert beyond["offset"] == 100_000 and beyond["next_offset"] is None


@pytest.mark.parametrize(
    "parameter,value",
    [
        ("limit", "0"),
        ("limit", "51"),
        ("limit", "1.5"),
        ("limit", "invalid"),
        ("offset", "-1"),
        ("offset", "100001"),
        ("offset", "1.5"),
        ("offset", "invalid"),
    ],
)
def test_mail_page_rejects_invalid_bounds(client, parameter, value):
    assert client.get("/v1/mail/threads", params={parameter: value}).status_code == 422


def test_overview_urgent_count_includes_all_pages_and_excludes_archived(large_mailbox):
    client, _, _ = large_mailbox
    assert client.get("/v1/overview").json()["counts"]["urgent_mail"] == 29
