"""Hosted daemon installer."""


async def test_install_script_is_shell_and_uses_public_url(client):
    r = await client.get("/install.sh")

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/x-shellscript")
    assert "Cache-Control" in r.headers
    assert r.text.startswith("#!/bin/sh")
    assert "DEFAULT_SERVER=http" in r.text
    assert "/api/install/spawnd/$TARGET" in r.text
    assert "https://github.com/levy-street/spawn.git" in r.text
    assert 'login --no-run' in r.text
    assert "spawnd.service" in r.text
