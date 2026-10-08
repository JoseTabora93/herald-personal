import json

import pytest


def test_msal_credential_does_not_contact_provider_for_status(tmp_path, monkeypatch):
    from herald_personal.oauth import MsalTokenSource

    cache = tmp_path / "cache.json"
    cache.write_text("{}")
    cache.chmod(0o600)
    source = MsalTokenSource(cache, "11111111-1111-1111-1111-111111111111", "organizations")
    monkeypatch.setattr(
        "herald_personal.oauth.msal.PublicClientApplication",
        lambda **kwargs: pytest.fail("network during status"),
    )
    assert source.configured is True


def test_msal_rejects_public_cache_and_missing_configuration(tmp_path):
    from herald_personal.oauth import MsalTokenSource

    cache = tmp_path / "cache.json"
    cache.write_text("{}")
    cache.chmod(0o644)
    source = MsalTokenSource(cache, "invalid", "https://evil.example")
    assert source.configured is False
    assert source.read() is None


def test_msal_silent_refresh_uses_read_scope_and_persists_private_cache(tmp_path, monkeypatch):
    from herald_personal.oauth import MsalTokenSource

    cache = tmp_path / "cache.json"
    cache.write_text("{}")
    cache.chmod(0o600)
    calls = []

    class FakeApp:
        def __init__(self, **kwargs):
            self.cache = kwargs["token_cache"]
            assert kwargs["authority"] == "https://login.microsoftonline.com/organizations"

        def get_accounts(self):
            return [{"home_account_id": "one"}]

        def acquire_token_silent(self, scopes, account):
            calls.append((scopes, account))
            self.cache.has_state_changed = True
            return {"access_token": "refreshed-test-token"}

    monkeypatch.setattr("herald_personal.oauth.msal.PublicClientApplication", FakeApp)
    source = MsalTokenSource(cache, "11111111-1111-1111-1111-111111111111", "organizations")
    assert source.read() == "refreshed-test-token"
    assert calls[0][0] == ["Mail.Read"]
    assert cache.stat().st_mode & 0o777 == 0o600
    assert isinstance(json.loads(cache.read_text()), dict)


def test_msal_failure_is_closed_and_never_exposes_credentials(tmp_path, monkeypatch):
    from herald_personal.oauth import MsalTokenSource

    cache = tmp_path / "cache.json"
    cache.write_text("{}")
    cache.chmod(0o600)

    def fail(**kwargs):
        raise RuntimeError("private-test-token")

    monkeypatch.setattr("herald_personal.oauth.msal.PublicClientApplication", fail)
    assert MsalTokenSource(cache, "11111111-1111-1111-1111-111111111111", "common").read() is None


def test_msal_does_not_guess_between_multiple_accounts(tmp_path, monkeypatch):
    from herald_personal.oauth import MsalTokenSource

    cache = tmp_path / "cache.json"
    cache.write_text("{}")
    cache.chmod(0o600)

    class FakeApp:
        def __init__(self, **kwargs):
            pass

        def get_accounts(self):
            return [{"id": "a"}, {"id": "b"}]

        def acquire_token_silent(self, *args, **kwargs):
            pytest.fail("ambiguous account")

    monkeypatch.setattr("herald_personal.oauth.msal.PublicClientApplication", FakeApp)
    assert MsalTokenSource(cache, "11111111-1111-1111-1111-111111111111", "common").read() is None
