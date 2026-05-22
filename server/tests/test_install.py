"""Hosted daemon installer."""


async def test_install_script_is_shell_and_uses_public_url(client):
    r = await client.get("/install.sh")

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/x-shellscript")
    assert "Cache-Control" in r.headers
    assert r.text.startswith("#!/bin/sh")
    assert "DEFAULT_SERVER=http" in r.text
    assert "--artifact-url" in r.text
    assert "--build-from-source" in r.text
    assert "install_prebuilt" in r.text
    assert "rel/spawnd_cli" in r.text
    assert "ping|stop|daemon|foreground|console" in r.text
    assert "erlang:system_info(otp_release)" in r.text
    assert "Erlang/OTP 27+ is required for --build-from-source" in r.text
    assert "rebar3 release && rebar3 escriptize" in r.text
    assert "https://github.com/levy-street/spawn.git" in r.text
    assert 'login --no-run' in r.text
    assert "spawnd.service" in r.text


async def test_legacy_backend_artifact_route_is_deprecated(client):
    r = await client.get("/api/install/spawnd/linux-x86_64")

    assert r.status_code == 404
    assert "/install/spawnd/linux-x86_64.tar.gz" in r.text
