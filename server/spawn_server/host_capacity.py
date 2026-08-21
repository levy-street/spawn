"""Validation for the capacity a daemon reports about its own machine.

Nothing a daemon sends is trusted into a column unchecked. A daemon is a
program on somebody's laptop; a compromised or simply buggy one must not be
able to write a 400-character CPU model, a negative core count, or a bucket
outside the meter's range into a row the UI renders.

Two shapes arrive, from two frames:

* ``spec`` on ``register`` — what the machine is. Written once per connection.
* ``cpu_bucket`` / ``mem_bucket`` on ``host.heartbeat`` — how hard it is
  working, as a meter segment count in ``0..=MAX_BUCKET``. Never a percentage:
  see ``daemon/src/host_metrics.rs`` and docs/TRUST.md for why the exact
  figures deliberately have no server code path at all.

Absence is always legitimate. A daemon older than these fields, and one running
with ``SPAWND_NO_TELEMETRY``, both report nothing, and both must keep working
exactly as they did before.
"""

from __future__ import annotations

from datetime import UTC, datetime

# Meter segments the UI draws. Mirrors `host_metrics::MAX_BUCKET`.
MAX_BUCKET = 5
# Guards against a host with a pathological (or forged) topology.
MAX_CORES = 4096
MAX_MODEL_CHARS = 128
# 1 PiB. Comfortably past any real machine, and short of anything that would
# make the summed "memory possessed" figure meaningless.
MAX_MEMORY_BYTES = 1 << 50


def _positive_int(value: object, *, limit: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value <= 0 or value > limit:
        return None
    return value


def _label(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    # Control characters would travel straight into the sidebar; a host name
    # is already sanitised elsewhere, and this is the same class of field.
    cleaned = "".join(ch for ch in value if ch.isprintable()).strip()
    return cleaned[:MAX_MODEL_CHARS] or None


def spec_values(raw: object) -> dict[str, object]:
    """Column values from a ``register`` frame's ``spec``, field by field.

    Returns only the fields that validated. A spec with a good core count and a
    nonsense memory figure stores the cores and leaves memory alone rather than
    discarding both — partial truth beats none, and each field stands alone.
    """
    if not isinstance(raw, dict):
        return {}
    values: dict[str, object] = {}
    cores = _positive_int(raw.get("cpu_cores"), limit=MAX_CORES)
    if cores is not None:
        values["cpu_cores"] = cores
    physical = _positive_int(raw.get("cpu_physical_cores"), limit=MAX_CORES)
    if physical is not None:
        values["cpu_physical_cores"] = physical
    model = _label(raw.get("cpu_model"))
    if model is not None:
        values["cpu_model"] = model
    memory = _positive_int(raw.get("memory_bytes"), limit=MAX_MEMORY_BYTES)
    if memory is not None:
        values["memory_bytes"] = memory
    gpu = _label(raw.get("gpu"))
    if gpu is not None:
        values["gpu"] = gpu
    return values


def _bucket(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > MAX_BUCKET:
        return None
    return value


def bucket_values(frame: dict) -> dict[str, object]:
    """Column values from a ``host.heartbeat``, or ``{}`` when it carries none.

    Both buckets move together and are stamped with the moment they landed:
    that stamp is the only thing separating "this machine is idle" from "this
    daemon never reports capacity", which are otherwise both two NULLs.
    """
    cpu = _bucket(frame.get("cpu_bucket"))
    memory = _bucket(frame.get("mem_bucket"))
    if cpu is None and memory is None:
        return {}
    return {
        "cpu_bucket": cpu,
        "mem_bucket": memory,
        "capacity_at": datetime.now(UTC),
    }
