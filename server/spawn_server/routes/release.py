"""Public release identity and compatibility contract."""

from __future__ import annotations

from fastapi import APIRouter, Response

from .. import release, schemas

router = APIRouter(prefix="/api/release", tags=["release"])


@router.get("", response_model=schemas.ReleaseOut)
async def get_release(response: Response) -> schemas.ReleaseOut:
    response.headers["Cache-Control"] = "no-store"
    return release.release_info()
