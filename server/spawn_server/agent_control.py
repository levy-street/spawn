"""Shared agent-control operations used by REST and browser WS."""

from __future__ import annotations

import base64
import binascii
import uuid
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Agent, User
from .ws.broker import get_broker

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_UPLOAD_NAME_LENGTH = 255
MAX_UPLOAD_MIME_LENGTH = 128
MAX_UPLOAD_CLIENT_ID_LENGTH = 128
UPLOAD_DESTINATION_CWD = "cwd"
TERMINAL_UI_AGENT_BINS = {"codex", "claude", "claude-code", "opencode", "aider"}


class UploadValidationError(ValueError):
    pass


async def get_owned_agent(session: AsyncSession, agent_id: str, user: User) -> Agent:
    agent = await session.get(Agent, agent_id)
    if agent is None or agent.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="agent not found")
    return agent


def upload_paste_prefix(argv: list[str]) -> str:
    if not argv:
        return ""
    binary = argv[0].rsplit("/", 1)[-1].lower()
    if binary in TERMINAL_UI_AGENT_BINS:
        return "@"
    return ""


def decode_upload(
    *,
    name: str | None,
    mime_type: str | None,
    bytes_b64: str,
    destination: str | None = None,
) -> tuple[str, str, str, str | None]:
    destination = destination if destination == UPLOAD_DESTINATION_CWD else None
    default_name = "file" if destination == UPLOAD_DESTINATION_CWD else "image"
    clean_name = str(name or default_name).strip()[:MAX_UPLOAD_NAME_LENGTH] or default_name
    clean_mime = str(mime_type or "").strip().lower()[:MAX_UPLOAD_MIME_LENGTH]
    if not clean_mime:
        clean_mime = "application/octet-stream"
    # Terminal pastes/drops are image-only (they become @path references for
    # TUIs); application/json is additionally allowed for the diagnostics
    # bundles the terminal refresh button saves to the agent host.
    if destination != UPLOAD_DESTINATION_CWD and not (
        clean_mime.startswith("image/") or clean_mime == "application/json"
    ):
        raise UploadValidationError("Only image files can be pasted or dropped here.")

    if not isinstance(bytes_b64, str) or not bytes_b64:
        raise UploadValidationError("Upload was empty.")
    try:
        data = base64.b64decode(bytes_b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise UploadValidationError("Upload was not valid base64.") from e

    if not data:
        raise UploadValidationError("Upload was empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadValidationError("Upload is too large; the limit is 20 MB.")

    return clean_name, clean_mime, base64.b64encode(data).decode("ascii"), destination


def daemon_for_agent(agent: Agent):
    daemon = get_broker().get_daemon_for_agent(agent.id) or get_broker().get_daemon_for_host(
        agent.host_id
    )
    if daemon is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="host daemon is offline")
    return daemon


async def upload_agent_file(
    *,
    session: AsyncSession,
    user: User,
    agent_id: str,
    name: str | None,
    mime_type: str | None,
    bytes_b64: str,
    paste: bool = True,
    destination: str | None = None,
    client_id: str | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    agent = await get_owned_agent(session, agent_id, user)
    daemon = daemon_for_agent(agent)
    try:
        clean_name, clean_mime, clean_b64, clean_destination = decode_upload(
            name=name,
            mime_type=mime_type,
            bytes_b64=bytes_b64,
            destination=destination,
        )
    except UploadValidationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    upload_client_id = (
        client_id[:MAX_UPLOAD_CLIENT_ID_LENGTH]
        if isinstance(client_id, str) and client_id.strip()
        else f"upload-{uuid.uuid4().hex}"
    )
    payload = {
        "type": "agent.upload",
        "agent_id": agent.id,
        "cwd": agent.cwd,
        "name": clean_name,
        "mime_type": clean_mime,
        "bytes_b64": clean_b64,
        "paste_prefix": upload_paste_prefix(list(agent.argv or [])),
        "paste": bool(paste),
        "destination": clean_destination,
        "client_id": upload_client_id,
    }
    try:
        result = await get_broker().request_upload(
            agent.id,
            daemon,
            payload=payload,
            client_id=upload_client_id,
            timeout=timeout,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    if result is None:
        raise HTTPException(status_code=504, detail="agent upload timed out")
    if result.get("code") == "upload_failed":
        raise HTTPException(
            status_code=400,
            detail=result.get("message") or "Agent upload failed.",
        )
    return {
        "agent_id": agent.id,
        "path": result["path"],
        "client_id": upload_client_id,
        "pasted": bool(paste),
    }
