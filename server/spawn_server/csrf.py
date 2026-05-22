"""CSRF protection for cookie-authenticated browser API requests."""

from __future__ import annotations

import secrets
from collections.abc import Awaitable, Callable

from fastapi import Request, Response
from starlette.responses import JSONResponse

CSRF_COOKIE = "spawn_csrf"
CSRF_HEADER = "x-csrf-token"
SESSION_COOKIE = "spawn_session"

_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_AUTH_EXEMPT_PATHS = {
    "/api/auth/signup",
    "/api/auth/login",
    "/api/auth/device/start",
    "/api/auth/device/poll",
}


def issue_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def _has_bearer(authorization: str | None) -> bool:
    if not authorization:
        return False
    parts = authorization.split(None, 1)
    return len(parts) == 2 and parts[0].lower() == "bearer" and bool(parts[1].strip())


async def csrf_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    if _requires_csrf(request):
        expected = request.cookies.get(CSRF_COOKIE)
        supplied = request.headers.get(CSRF_HEADER)
        if not expected or not supplied or not secrets.compare_digest(expected, supplied):
            return JSONResponse({"detail": "CSRF token missing or invalid"}, status_code=403)
    return await call_next(request)


def _requires_csrf(request: Request) -> bool:
    if request.method.upper() not in _UNSAFE_METHODS:
        return False
    if request.url.path in _AUTH_EXEMPT_PATHS:
        return False
    if not request.url.path.startswith("/api/"):
        return False
    if not request.cookies.get(SESSION_COOKIE):
        return False
    return not _has_bearer(request.headers.get("authorization"))
