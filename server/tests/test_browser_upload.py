"""Browser image upload validation."""

from __future__ import annotations

import base64

import pytest

from spawn_server.agent_control import upload_paste_prefix
from spawn_server.ws.browser import (
    UploadValidationError,
    _decode_image_upload,
    _decode_upload,
)


def test_decode_image_upload_canonicalizes_payload():
    name, mime_type, bytes_b64 = _decode_image_upload(
        {
            "name": " screenshot.png ",
            "mime_type": "IMAGE/PNG",
            "bytes_b64": base64.b64encode(b"png-ish").decode("ascii"),
        }
    )

    assert name == "screenshot.png"
    assert mime_type == "image/png"
    assert base64.b64decode(bytes_b64) == b"png-ish"


def test_decode_upload_allows_generic_files_to_cwd():
    name, mime_type, bytes_b64, destination = _decode_upload(
        {
            "destination": "cwd",
            "name": " notes.txt ",
            "mime_type": "text/plain",
            "bytes_b64": base64.b64encode(b"hello").decode("ascii"),
        }
    )

    assert name == "notes.txt"
    assert mime_type == "text/plain"
    assert base64.b64decode(bytes_b64) == b"hello"
    assert destination == "cwd"


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"name": "x.txt", "mime_type": "text/plain", "bytes_b64": "eA=="}, "Only image"),
        ({"name": "x.png", "mime_type": "image/png", "bytes_b64": "not-base64"}, "base64"),
        ({"name": "x.png", "mime_type": "image/png", "bytes_b64": ""}, "empty"),
    ],
)
def test_decode_image_upload_rejects_bad_payloads(payload, message):
    with pytest.raises(UploadValidationError, match=message):
        _decode_image_upload(payload)


@pytest.mark.parametrize(
    ("argv", "prefix"),
    [
        (["codex", "--yolo"], "@"),
        (["/usr/local/bin/claude"], "@"),
        (["opencode"], "@"),
        (["aider", "--model", "sonnet"], "@"),
        (["bash", "-l"], ""),
    ],
)
def test_upload_paste_prefix(argv, prefix):
    assert upload_paste_prefix(argv) == prefix
