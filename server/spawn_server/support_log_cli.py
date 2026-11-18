"""Local operator access to support collections. The database is the queue."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.exc import SQLAlchemyError

from .auth import normalize_email
from .db import dispose_engine, get_sessionmaker
from .models import Host, SupportLogCollection, User, _utcnow
from .routes.support_log import MAX_BUNDLE, validate_bundle
from .support_consent import sharing_on
from .support_log import (
    OPEN_STATES,
    RequestRefusal,
    RequestRefused,
    clamp_window,
    create_request,
    get_collection,
)
from .support_log_files import open_existing_store
from .support_log_retention import sweep_once

EXIT_CODES = {
    RequestRefusal.SHARING_OFF: 3,
    RequestRefusal.FOREIGN_HOST: 4,
    RequestRefusal.INCAPABLE: 5,
    RequestRefusal.OPEN: 6,
    RequestRefusal.HOST_INTERVAL: 7,
    RequestRefusal.ACCOUNT_LIMIT: 7,
    RequestRefusal.CAPACITY: 7,
}


class CommandError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise CommandError(2, "See --help for valid arguments.")


def arguments(argv):
    output = argparse.ArgumentParser(add_help=False)
    output.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    parser = Parser(description=__doc__, parents=[output])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("accounts", parents=[output])
    collect = commands.add_parser("collect", parents=[output])
    collect.add_argument("--account", required=True)
    collect.add_argument("--host", required=True)
    collect.add_argument("--reason", required=True)
    collect.add_argument("--by", default=os.environ.get("SPAWN_SUPPORT_LOG_BY"))
    collect.add_argument("--hours", type=float, default=24)
    collect.add_argument("--wait", type=int, default=0)
    status = commands.add_parser("status", parents=[output])
    status.add_argument("id")
    listing = commands.add_parser("list", parents=[output])
    listing.add_argument("--account")
    listing.add_argument("--days", type=int, default=7)
    show = commands.add_parser("show", parents=[output])
    show.add_argument("id")
    show.add_argument("--raw", action="store_true")
    commands.add_parser("purge", parents=[output])
    args = parser.parse_args(argv)
    if args.command == "collect":
        if not args.by or not args.by.strip():
            raise CommandError(2, "Supply an operator label with --by or SPAWN_SUPPORT_LOG_BY.")
        if not args.reason.strip() or not 1 <= len(args.reason) <= 200:
            raise CommandError(2, "Supply a reason of 1 to 200 characters.")
        if not 0 < args.hours <= 72 or not 0 <= args.wait <= 86400:
            raise CommandError(2, "Supply positive hours up to 72 and a wait of 0 to 86400 seconds.")
    if args.command == "list" and args.days < 1:
        raise CommandError(2, "Supply a positive day count.")
    if args.command == "show" and args.raw and getattr(args, "json", False):
        raise CommandError(2, "Choose one output format.")
    if args.command == "show" and args.raw and sys.stdout.isatty():
        raise CommandError(2, "Raw output requires a pipe or a file.")
    return args


async def account_id(session, lookup):
    owner = await session.scalar(
        select(User.id).where(
            or_(User.id == lookup, func.lower(User.email) == normalize_email(lookup)),
        )
    )
    if owner is None:
        raise CommandError(9, "No such account.")
    return owner


async def resolve_host(session, owner, lookup):
    ids = (
        await session.scalars(
            select(Host.id)
            .where(
                Host.owner_user_id == owner,
                or_(Host.id == lookup, Host.name == lookup),
            )
            .order_by((Host.id == lookup).desc())
            .limit(2)
        )
    ).all()
    if not ids:
        raise RequestRefused(RequestRefusal.FOREIGN_HOST)
    if len(ids) > 1 and ids[0] != lookup:
        raise CommandError(2, "Supply the host ID because several hosts have that name.")
    return ids[0]


async def record_for(record_id):
    record = await get_collection(record_id)
    if record is None:
        raise CommandError(9, "No such collection.")
    return record


def summary(record):
    return {
        "id": record.id,
        "account_id": record.owner_user_id,
        "host_id": record.host_id,
        "state": record.state,
        "decline_code": record.decline_code,
        "requested_at": record.requested_at,
        "dispatched_at": record.dispatched_at,
        "completed_at": record.completed_at,
        "expires_at": record.expires_at,
        "size_bytes": record.size_bytes,
        "line_count": record.line_count,
    }


async def wait_for_record(record_id, seconds, *, clock=time.monotonic, sleep=asyncio.sleep):
    start = clock()
    while True:
        record = await record_for(record_id)
        remaining = seconds - (clock() - start)
        if record.state not in OPEN_STATES or remaining <= 0:
            return record
        await sleep(min(1, remaining))


async def command(args, store):
    if args.command == "accounts":
        async with get_sessionmaker()() as session:
            rows = await session.execute(
                select(
                    User.id,
                    Host.id.label("host_id"),
                    Host.name,
                    Host.last_seen_at,
                    Host.support_log_capable,
                )
                .outerjoin(Host, Host.owner_user_id == User.id)
                .where(sharing_on(User.id))
                .order_by(User.id, Host.name, Host.id)
            )
            accounts = {}
            for row in rows:
                hosts = accounts.setdefault(row.id, [])
                if row.host_id is not None:
                    hosts.append(
                        dict(
                            id=row.host_id,
                            name=row.name,
                            last_seen_at=row.last_seen_at,
                            capable=row.support_log_capable,
                        )
                    )
        return {"accounts": [dict(id=owner, hosts=hosts) for owner, hosts in accounts.items()]}
    if args.command == "collect":
        async with get_sessionmaker()() as session:
            owner = await account_id(session, args.account)
            host = await resolve_host(session, owner, args.host)
        seconds = clamp_window(int(args.hours * 3600))
        record_id = await create_request(
            owner_user_id=owner,
            host_id=host,
            requested_by=args.by,
            reason=args.reason,
            window_seconds=seconds,
        )
        return summary(await wait_for_record(record_id, args.wait))
    if args.command == "status":
        return summary(await record_for(args.id))
    if args.command == "list":
        async with get_sessionmaker()() as session:
            now = _utcnow()
            # A longer window includes all representable record dates.
            days = min(args.days, (now - datetime.min.replace(tzinfo=UTC)).days)
            query = select(SupportLogCollection).where(
                SupportLogCollection.requested_at >= now - timedelta(days=days),
            )
            if args.account is not None:
                owner = await account_id(session, args.account)
                query = query.where(SupportLogCollection.owner_user_id == owner)
            rows = await session.scalars(
                query.order_by(SupportLogCollection.requested_at.desc(), SupportLogCollection.id)
            )
            return {"collections": [summary(row) for row in rows]}
    if args.command == "show":
        async with store.locked():
            record = await record_for(args.id)
            if record.state != "collected":
                raise CommandError(9, "This request has no collected bundle.")
            expiry = record.expires_at
            if expiry is not None and expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=UTC)
            if expiry is None or expiry <= _utcnow():
                raise CommandError(9, "This bundle has expired.")
            try:
                body = await asyncio.to_thread(verified_bundle, store, record)
            except FileNotFoundError:
                raise CommandError(9, "The bundle file is missing.") from None
            except (OSError, ValueError, TypeError, RecursionError):
                raise CommandError(9, "The bundle failed verification.") from None
        return body
    await sweep_once(store)
    return {"message": "The retention pass finished."}


def verified_bundle(store, record):
    body = store.read(record.id, MAX_BUNDLE)
    if len(body) > MAX_BUNDLE or len(body) != record.size_bytes:
        raise ValueError
    validate_bundle(body, {"digest": record.digest, "line_count": record.line_count})
    return body


def display_bundle(body, as_json):
    # Framing has already been verified. Literal tabs and carriage returns can
    # only be JSON whitespace. Escape non-ASCII text and DEL inside strings,
    # preserving numeric spellings and existing JSON escapes.
    lines = body.decode("utf-8").replace("\t", " ").replace("\r", " ").split("\n")[:-1]
    safe = [re.sub(r"[^ -~]+", lambda m: json.dumps(m[0])[1:-1], line) for line in lines]
    print('{"bundle":[' + ",".join(safe) + "]}" if as_json else "\n".join(safe))


async def run(argv):
    code = 0
    as_json = "--json" in argv
    try:
        args = arguments(argv)
        as_json = getattr(args, "json", False)
        store = await asyncio.to_thread(open_existing_store)
        try:
            result = await command(args, store)
        finally:
            await asyncio.to_thread(store.close)
    except RequestRefused as exc:
        code, result = EXIT_CODES[exc.reason], {"error": exc.reason.value}
    except CommandError as exc:
        code, result = exc.code, {"error": str(exc)}
    except (OSError, SQLAlchemyError):
        code, result = 8, {"error": "Support log storage is not usable."}

    if isinstance(result, bytes):
        if args.raw:
            sys.stdout.buffer.write(result)
        else:
            display_bundle(result, as_json)
    elif as_json:
        print(json.dumps(result, default=str))
    elif code:
        print(result["error"], file=sys.stderr)
    elif "message" in result:
        print(result["message"])
    elif "accounts" in result:
        if not result["accounts"]:
            print("No accounts have sharing on.")
        for account in result["accounts"]:
            print(f"Sharing is on for account {account['id']}.")
            for host in account["hosts"]:
                seen = host["last_seen_at"] or "unknown"
                capability = "capable" if host["capable"] else "capability undeclared"
                print(f"  {host['id']}  {json.dumps(host['name'])}  {capability}  last seen {seen}")
    else:
        records = result.get("collections", [result])
        if not records:
            print("No collections in this period.")
        for record in records:
            detail = f" ({record['decline_code']})" if record["decline_code"] else ""
            print(
                f"Request {record['id']} for host {record['host_id']} is {record['state']}{detail}."
            )
    return code


async def main():
    try:
        return await run(sys.argv[1:])
    finally:
        await dispose_engine()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
