import pytest

from spawn_server import transcript
from spawn_server.config import get_settings

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _transcript_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("SPAWN_TRANSCRIPT_DIR", str(tmp_path / "transcripts"))
    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


async def test_read_returns_full_transcript_without_cap():
    await transcript.append("agent-full", b"one\n")
    await transcript.append("agent-full", b"two\n")
    assert await transcript.read("agent-full") == b"one\ntwo\n"


async def test_read_with_max_bytes_returns_newest_tail():
    await transcript.append("agent-tail", b"a" * 100 + b"b" * 100)
    data = await transcript.read("agent-tail", max_bytes=50)
    assert data == b"b" * 50


async def test_read_with_max_bytes_spans_rotated_files(monkeypatch):
    monkeypatch.setenv("SPAWN_TRANSCRIPT_MAX_BYTES_PER_FILE", "100")
    get_settings.cache_clear()  # type: ignore[attr-defined]

    await transcript.append("agent-rotate", b"o" * 100)  # fills .log, rotates next
    await transcript.append("agent-rotate", b"n" * 40)  # new .log head

    # Budget larger than the newest file: tail of the rotated file fills the rest.
    data = await transcript.read("agent-rotate", max_bytes=60)
    assert data == b"o" * 20 + b"n" * 40

    # Budget smaller than the newest file: only its tail.
    data = await transcript.read("agent-rotate", max_bytes=10)
    assert data == b"n" * 10
