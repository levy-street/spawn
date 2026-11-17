"""Daemon-only bounded uploads. Nothing in this change dispatches a request."""

from __future__ import annotations

import asyncio
import hashlib
import re
from contextlib import contextmanager
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.requests import ClientDisconnect

from .. import auth
from ..db import get_sessionmaker
from ..models import SupportLogCollection, _utcnow
from ..support_consent import ConsentError, canonical_uuid, is_sharing_on, strict_json
from ..support_log import DECLINE_CODES, get_collection, transition
from ..support_log_files import finish_job, get_store

router = APIRouter(prefix="/api/support-log", tags=["support-log"])
MAX_BUNDLE = 921600
MAX_REFUSAL = 256
MAX_BODY_READS = 4
RECEIVE_SECONDS = 60
NOT_FOUND = "Not Found"
_inflight: set[str] = set()
_reading: set[str] = set()


@contextmanager
def upload_slots(record_id: str):
    # No await between checking and reserving: admission is atomic on this loop.
    if record_id in _inflight:
        raise HTTPException(409, "support upload already in progress")
    if len(_reading) >= MAX_BODY_READS:
        raise HTTPException(503, "support upload capacity reached")
    _inflight.add(record_id)
    _reading.add(record_id)
    try:
        yield
    finally:
        _reading.discard(record_id)
        _inflight.remove(record_id)


def content_length(request: Request, limit: int) -> int | None:
    lengths = request.headers.getlist("content-length")
    length = None
    if lengths:
        if len(lengths) != 1 or re.fullmatch(r"[0-9]+", lengths[0]) is None:
            raise HTTPException(400, "invalid content length")
        digits = lengths[0].lstrip("0") or "0"
        if len(digits) > len(str(limit)):
            raise HTTPException(413, "support log body too large")
        length = int(digits)
        if length > limit:
            raise HTTPException(413, "support log body too large")
    return length


async def bounded_body(request: Request, limit: int) -> bytearray:
    length = content_length(request, limit)
    body = bytearray()
    try:
        async with asyncio.timeout(RECEIVE_SECONDS):
            async for chunk in request.stream():
                # A transport may hand us a huge chunk. Never copy it beyond limit + 1.
                body.extend(memoryview(chunk)[: limit + 1 - len(body)])
                if len(body) > limit:
                    raise HTTPException(413, "support log body too large")
    except TimeoutError:
        raise HTTPException(408, "support log receive deadline exceeded") from None
    if length is not None and length != len(body):
        raise HTTPException(400, "content length mismatch")
    return body


def bundle_metadata(headers) -> dict:
    def field(suffix):
        values = headers.getlist(f"x-spawn-support-log-{suffix}")
        if len(values) != 1:
            raise ValueError
        return values[0]

    digest, lines = field("sha256"), field("lines")
    start, end, truncated = field("from"), field("to"), field("truncated")
    if re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ValueError
    if re.fullmatch(r"[0-9]{1,20}", lines) is None:
        raise ValueError
    for stamp in (start, end):
        if re.fullmatch(r"-?[0-9]{1,19}", stamp) is None:
            raise ValueError
        if not -(1 << 63) <= int(stamp) < 1 << 63:
            raise ValueError
    count, start, end = int(lines), int(start), int(end)
    if count > MAX_BUNDLE // 3 - 1 or start > end:
        raise ValueError
    if count == 0 and (start != 0 or end != 0):
        raise ValueError
    if truncated not in {"true", "false"}:
        raise ValueError
    return dict(
        digest=digest, line_count=count, log_from=start, log_to=end, truncated=truncated == "true"
    )


def validate_bundle(body: bytearray, metadata: dict):
    if hashlib.sha256(body).hexdigest() != metadata["digest"] or not body.endswith(b"\n"):
        raise ValueError
    # The first object is the header; Lines excludes it. Event fields remain opaque.
    lines = body.decode("utf-8").split("\n")[:-1]
    if len(lines) != metadata["line_count"] + 1:
        raise ValueError
    for line in lines:
        if not isinstance(strict_json(line), dict):
            raise ValueError


async def publish(store, record, body, metadata):
    async with store.locked():
        current = await get_collection(record.id)
        if current is None or current.state != "dispatched":
            raise HTTPException(409, "support request closed")
        if not await is_sharing_on(record.owner_user_id):
            await transition(record.id, "dispatched", "cancelled")
            raise HTTPException(409, "support sharing is off")
        committed = False
        try:
            await asyncio.to_thread(store.write, record.id, body)
            now = _utcnow()
            committed = await transition(
                record.id,
                "dispatched",
                "collected",
                require_sharing=True,
                now=now,
                expires_at=now + timedelta(days=7),
                size_bytes=len(body),
                **metadata,
            )
            if not committed:
                await transition(record.id, "dispatched", "cancelled")
                raise HTTPException(409, "support request closed")
        finally:
            if not committed:
                await asyncio.to_thread(store.remove, record.id)


@router.post("/uploads/{request_id}", status_code=204)
async def upload(request_id: str, request: Request):
    store = get_store(request.app)
    if store is None:
        raise HTTPException(404, NOT_FOUND)
    # Explicit dependency scope ends before a body read, including auth's SELECT.
    async with get_sessionmaker()() as session:
        host = await auth.daemon_principal(request.headers.get("authorization"), session)
        try:
            canonical_uuid(request_id)
        except ConsentError:
            raise HTTPException(404, NOT_FOUND) from None
        record = await session.get(SupportLogCollection, request_id)
        if (
            record is None
            or record.host_id != host.id
            or record.owner_user_id != host.owner_user_id
        ):
            raise HTTPException(404, NOT_FOUND)
        if record.state != "dispatched":
            raise HTTPException(409, "support request closed")
    with upload_slots(record.id):
        if not await is_sharing_on(record.owner_user_id):
            await transition(record.id, "dispatched", "cancelled")
            raise HTTPException(409, "support sharing is off")
        content_type = request.headers.get("content-type", "")
        try:
            if content_type == "application/x-ndjson":
                content_length(request, MAX_BUNDLE)
                metadata = bundle_metadata(request.headers)
                body = await bounded_body(request, MAX_BUNDLE)
                _reading.remove(record.id)
                await asyncio.to_thread(validate_bundle, body, metadata)
                await finish_job(publish(store, record, body, metadata))
            elif content_type == "application/json":
                body = await bounded_body(request, MAX_REFUSAL)
                _reading.remove(record.id)
                refusal = strict_json(bytes(body))
                if (
                    not isinstance(refusal, dict)
                    or set(refusal) != {"declined"}
                    or not isinstance(refusal["declined"], str)
                    or refusal["declined"] not in DECLINE_CODES
                ):
                    raise ValueError
                changed = await transition(
                    record.id,
                    "dispatched",
                    "declined",
                    require_sharing=True,
                    decline_code=refusal["declined"],
                )
                if not changed:
                    await transition(record.id, "dispatched", "cancelled")
                    raise HTTPException(409, "support request closed")
            else:
                raise HTTPException(415, "unsupported support log content type")
        except (ValueError, UnicodeError, RecursionError) as exc:
            await transition(record.id, "dispatched", "failed")
            raise HTTPException(400, "invalid support log upload") from exc
        except HTTPException as exc:
            if exc.status_code in {400, 408, 413, 415}:
                await transition(record.id, "dispatched", "failed")
            raise
        except ClientDisconnect:
            await transition(record.id, "dispatched", "failed")
            raise HTTPException(400, "incomplete support log upload") from None
        except Exception:
            await transition(record.id, "dispatched", "failed")
            raise HTTPException(500, "support log storage failed") from None
    return Response(status_code=204)
