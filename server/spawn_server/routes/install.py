"""Hosted shell installer for `spawnd`.

The Next.js web app is the canonical installer/artifact host in production,
but FastAPI also exposes `/install.sh` for direct-backend development and
backward compatibility. Keep it sourced from the same shell template so the two
origins do not drift.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse

from ..config import get_settings

router = APIRouter(tags=["install"])

DEFAULT_REPO = "https://github.com/levy-street/spawn.git"
DEFAULT_BRANCH = "master"
REPO_ROOT = Path(__file__).resolve().parents[3]
TEMPLATE_PATH = REPO_ROOT / "web" / "src" / "app" / "install.sh" / "install-template.sh"


@router.get("/api/install/spawnd/{target}")
async def spawnd_binary(target: str) -> None:
    """Deprecated artifact route kept as a clear error for old clients."""

    raise HTTPException(
        status_code=404,
        detail=f"daemon artifacts are served by spawn-web at /install/spawnd/{target}.tar.gz",
    )


@router.get("/install.sh", response_class=PlainTextResponse)
async def install_script(request: Request) -> PlainTextResponse:
    """Return a curl-pipeable installer for daemon hosts."""

    script = (
        TEMPLATE_PATH.read_text(encoding="utf-8")
        .replace("__DEFAULT_SERVER__", _sh_quote(_public_url(request)))
        .replace("__DEFAULT_REPO__", _sh_quote(_default_repo()))
        .replace("__DEFAULT_BRANCH__", _sh_quote(_default_branch()))
    )
    return PlainTextResponse(
        script,
        media_type="text/x-shellscript; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


def _public_url(request: Request) -> str:
    configured = get_settings().public_url.strip().rstrip("/")
    if configured and configured != "http://localhost:8000":
        return configured

    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme).split(",")[0].strip()
    if host:
        return f"{proto}://{host}".rstrip("/")
    return str(request.base_url).rstrip("/")


def _default_repo() -> str:
    return os.environ.get("SPAWN_INSTALL_REPO") or DEFAULT_REPO


def _default_branch() -> str:
    return os.environ.get("SPAWN_INSTALL_BRANCH") or DEFAULT_BRANCH


def _sh_quote(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_@%+=:,./-]+", value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"
