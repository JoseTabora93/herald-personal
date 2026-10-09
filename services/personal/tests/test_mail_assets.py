import httpx
import pytest
from test_mail_workspace import workspace_client

REF = {"kind": "attachment", "clave": "MAIL-12", "message_id": "msg+/=", "attachment_id": "att+/="}
PNG = b"\x89PNG\r\n\x1a\n" + b"image"


def test_download_is_binary_bounded_and_uses_fixed_origin(settings):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(
            200, content=PNG, headers={"content-type": "image/png", "x-mail-filename": "photo.png"}
        )

    with workspace_client(settings, handler) as client:
        r = client.post("/v1/mail-workspace/asset", json=REF)
        assert r.status_code == 200
        assert r.content == PNG
        assert r.headers["content-type"] == "image/png"
        assert r.headers["x-mail-filename"] == "photo.png"
    assert seen[0].method == "GET"
    assert seen[0].url.path == "/api/mail-attachment"
    assert seen[0].url.params["mensaje"] == REF["message_id"]
    assert "cookie" not in seen[0].headers


@pytest.mark.parametrize("ref", [{"kind": "signature"}, REF])
def test_asset_does_not_follow_redirect_or_leak_error(settings, ref):
    with workspace_client(
        settings,
        lambda r: httpx.Response(302, headers={"location": "https://evil.test"}, text="PRIVATE"),
    ) as client:
        r = client.post("/v1/mail-workspace/asset", json=ref)
        assert r.status_code == 502
        assert "PRIVATE" not in r.text


@pytest.mark.parametrize(
    "ref",
    [
        {**REF, "url": "https://evil.test"},
        {**REF, "attachment_id": "../x"},
        {"kind": "attachment"},
        {"kind": "signature", "clave": "MAIL-1"},
    ],
)
def test_invalid_reference_never_fetches(settings, ref):
    seen = []
    with workspace_client(settings, lambda r: seen.append(r)) as client:
        assert client.post("/v1/mail-workspace/asset", json=ref).status_code == 422
    assert not seen


def test_signature_is_read_only_raster(settings):
    def handler(request):
        assert request.url.path == "/api/firma-imagen" and request.method == "GET"
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    with workspace_client(settings, handler) as client:
        assert client.post("/v1/mail-workspace/asset", json={"kind": "signature"}).content == PNG
    with workspace_client(
        settings,
        lambda r: httpx.Response(200, content=b"<svg/>", headers={"content-type": "image/svg+xml"}),
    ) as client:
        assert (
            client.post("/v1/mail-workspace/asset", json={"kind": "signature"}).status_code == 502
        )


def test_oversize_asset_is_rejected(settings):
    with workspace_client(
        settings,
        lambda r: httpx.Response(200, headers={"content-length": "30000000"}, content=b"x"),
    ) as client:
        assert client.post("/v1/mail-workspace/asset", json=REF).status_code == 502
