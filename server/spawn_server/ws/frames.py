"""Binary frame helpers for the spawn.v1 wire protocol.

Layout:
    +------+--------------+-----------------+
    | kind | agent_id     | payload         |
    | u8   | 16 bytes     | N bytes         |
    +------+--------------+-----------------+

kind = 0x01 PTY output (daemon → server → browsers)
kind = 0x02 PTY input  (browser → server → daemon)
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

KIND_OUTPUT = 0x01
KIND_INPUT = 0x02

HEADER_LEN = 1 + 16  # kind + uuid bytes


@dataclass(frozen=True)
class BinaryFrame:
    kind: int
    agent_id: str  # canonical UUID string
    payload: bytes

    def encode(self) -> bytes:
        return encode_binary_frame(self.kind, self.agent_id, self.payload)


def encode_binary_frame(kind: int, agent_id: str, payload: bytes) -> bytes:
    if kind not in (KIND_OUTPUT, KIND_INPUT):
        raise ValueError(f"invalid frame kind: {kind:#x}")
    uid_bytes = uuid.UUID(agent_id).bytes  # 16-byte big-endian
    return bytes([kind]) + uid_bytes + payload


def decode_binary_frame(buf: bytes) -> BinaryFrame:
    if len(buf) < HEADER_LEN:
        raise ValueError(f"binary frame too short: {len(buf)} bytes")
    kind = buf[0]
    if kind not in (KIND_OUTPUT, KIND_INPUT):
        raise ValueError(f"invalid frame kind: {kind:#x}")
    uid = uuid.UUID(bytes=bytes(buf[1:HEADER_LEN]))
    payload = bytes(buf[HEADER_LEN:])
    return BinaryFrame(kind=kind, agent_id=str(uid), payload=payload)
