"""OAuth authorization-code flow for ChatGPT Apps / remote MCP clients."""

from __future__ import annotations

import base64
import hashlib
from urllib.parse import parse_qs, urlparse


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


async def _register_client(client, redirect_uri: str = "https://chat.openai.com/aip/callback"):
    response = await client.post(
        "/api/oauth/register",
        json={
            "client_name": "ChatGPT Spawn",
            "redirect_uris": [redirect_uri],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "scope": "spawn",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_oauth_discovery_and_client_registration(client):
    resource = await client.get("/.well-known/oauth-protected-resource/mcp")
    assert resource.status_code == 200
    assert resource.json()["resource"] == "http://localhost:8000/mcp"
    assert resource.json()["authorization_servers"] == ["http://localhost:8000"]
    root_resource = await client.get("/.well-known/oauth-protected-resource")
    assert root_resource.status_code == 200
    assert root_resource.json() == resource.json()

    metadata = await client.get("/.well-known/oauth-authorization-server")
    assert metadata.status_code == 200
    body = metadata.json()
    assert body["issuer"] == "http://localhost:8000"
    assert body["authorization_endpoint"] == "http://localhost:8000/api/oauth/authorize"
    assert body["token_endpoint"] == "http://localhost:8000/api/oauth/token"
    assert body["registration_endpoint"] == "http://localhost:8000/api/oauth/register"
    assert body["code_challenge_methods_supported"] == ["S256"]
    assert body["token_endpoint_auth_methods_supported"] == ["none"]

    registered = await _register_client(client)
    assert registered["client_id"].startswith("spawn_")
    assert registered["client_name"] == "ChatGPT Spawn"
    assert registered["scope"] == "spawn"
    assert registered["redirect_uris"] == ["https://chat.openai.com/aip/callback"]


async def test_oauth_signup_authorize_token_refresh_and_mcp_verifier(client):
    registered = await _register_client(client)
    verifier = "correct-horse-battery-staple-verifier"
    params = {
        "response_type": "code",
        "client_id": registered["client_id"],
        "redirect_uri": registered["redirect_uris"][0],
        "scope": "spawn",
        "state": "state-123",
        "code_challenge": _challenge(verifier),
        "code_challenge_method": "S256",
    }

    authorize_page = await client.get("/api/oauth/authorize", params=params)
    assert authorize_page.status_code == 200
    assert "Create account and authorize" in authorize_page.text

    redirect = await client.post(
        "/api/oauth/authorize",
        data={
            **params,
            "action": "signup",
            "email": "oauth-chatgpt@example.com",
            "password": "passpasspass",
        },
        follow_redirects=False,
    )
    assert redirect.status_code == 302, redirect.text
    callback = urlparse(redirect.headers["location"])
    query = parse_qs(callback.query)
    assert query["state"] == ["state-123"]
    code = query["code"][0]
    me = await client.get("/api/me")
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "oauth-chatgpt@example.com"

    token = await client.post(
        "/api/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": registered["client_id"],
            "redirect_uri": registered["redirect_uris"][0],
            "code": code,
            "code_verifier": verifier,
        },
    )
    assert token.status_code == 200, token.text
    token_body = token.json()
    assert token_body["token_type"] == "Bearer"
    assert token_body["scope"] == "spawn"
    assert token_body["access_token"]
    assert token_body["refresh_token"]

    replay = await client.post(
        "/api/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": registered["client_id"],
            "redirect_uri": registered["redirect_uris"][0],
            "code": code,
            "code_verifier": verifier,
        },
    )
    assert replay.status_code == 400
    assert replay.json()["error"] == "invalid_grant"

    refresh = await client.post(
        "/api/oauth/token",
        data={
            "grant_type": "refresh_token",
            "client_id": registered["client_id"],
            "refresh_token": token_body["refresh_token"],
        },
    )
    assert refresh.status_code == 200, refresh.text
    refreshed_body = refresh.json()
    assert refreshed_body["access_token"]
    assert refreshed_body["refresh_token"] != token_body["refresh_token"]

    refresh_replay = await client.post(
        "/api/oauth/token",
        data={
            "grant_type": "refresh_token",
            "client_id": registered["client_id"],
            "refresh_token": token_body["refresh_token"],
        },
    )
    assert refresh_replay.status_code == 400
    assert refresh_replay.json()["error"] == "invalid_grant"

    from spawn_server.mcp import SpawnTokenVerifier

    access = await SpawnTokenVerifier().verify_token(refreshed_body["access_token"])
    assert access is not None
    assert access.scopes == ["spawn"]


async def test_oauth_login_existing_account_authorizes_client(client):
    signup = await client.post(
        "/api/auth/signup",
        json={"email": "oauth-login@example.com", "password": "passpasspass"},
    )
    assert signup.status_code == 200
    await client.post("/api/auth/logout")
    client.cookies.clear()

    registered = await _register_client(client)
    verifier = "login-flow-correct-verifier"
    params = {
        "response_type": "code",
        "client_id": registered["client_id"],
        "redirect_uri": registered["redirect_uris"][0],
        "scope": "spawn",
        "state": "login-state",
        "code_challenge": _challenge(verifier),
        "code_challenge_method": "S256",
    }

    redirect = await client.post(
        "/api/oauth/authorize",
        data={
            **params,
            "action": "login",
            "email": "oauth-login@example.com",
            "password": "passpasspass",
        },
        follow_redirects=False,
    )
    assert redirect.status_code == 302, redirect.text
    query = parse_qs(urlparse(redirect.headers["location"]).query)
    assert query["state"] == ["login-state"]
    assert query["code"][0]
    me = await client.get("/api/me")
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "oauth-login@example.com"


async def test_oauth_authorize_rejects_invalid_pkce_and_redirects_denial(client):
    registered = await _register_client(client, "http://localhost:8765/callback")
    params = {
        "response_type": "code",
        "client_id": registered["client_id"],
        "redirect_uri": "http://localhost:8765/callback",
        "scope": "spawn",
        "state": "state-deny",
        "code_challenge": "plain-is-not-accepted",
        "code_challenge_method": "plain",
    }
    invalid = await client.get("/api/oauth/authorize", params=params, follow_redirects=False)
    assert invalid.status_code == 302
    invalid_query = parse_qs(urlparse(invalid.headers["location"]).query)
    assert invalid_query["error"] == ["invalid_request"]
    assert invalid_query["state"] == ["state-deny"]

    verifier = "another-correct-verifier"
    valid_params = {
        **params,
        "code_challenge": _challenge(verifier),
        "code_challenge_method": "S256",
    }
    signup = await client.post(
        "/api/oauth/authorize",
        data={
            **valid_params,
            "action": "signup",
            "email": "oauth-deny@example.com",
            "password": "passpasspass",
        },
        follow_redirects=False,
    )
    assert signup.status_code == 302
    client.cookies.clear()

    page = await client.post(
        "/api/oauth/authorize",
        data={**valid_params, "action": "deny"},
        follow_redirects=False,
    )
    assert page.status_code == 302
    denied_query = parse_qs(urlparse(page.headers["location"]).query)
    assert denied_query["error"] == ["access_denied"]
    assert denied_query["state"] == ["state-deny"]
