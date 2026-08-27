"""Public release identity and verified prebuilt manifests."""

from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace

import pytest

from spawn_server import release

COMMIT = "1" * 40
DAEMON_TREE = "2" * 40
MOBILE_TREE = "3" * 40
DESKTOP_TREE = "4" * 40
DESKTOP_VERSION = "0.1.0"


def _stage_manifest(tmp_path, *, corrupt_worker: bool = False) -> dict:
    prebuilt = tmp_path / "daemon" / "target" / "prebuilt"
    target_dir = prebuilt / "linux-x86_64"
    target_dir.mkdir(parents=True)
    spawnd = b"verified-spawnd"
    worker = b"verified-worker"
    (target_dir / "spawnd").write_bytes(spawnd)
    (target_dir / "spawn-worker").write_bytes(worker + (b"-corrupt" if corrupt_worker else b""))
    manifest = {
        "commit": COMMIT,
        "tree": DAEMON_TREE,
        "version": "0.1.0+g111111111111",
        "targets": {
            "linux-x86_64": {
                "spawnd_sha256": hashlib.sha256(spawnd).hexdigest(),
                "spawn_worker_sha256": hashlib.sha256(worker).hexdigest(),
            }
        },
    }
    (prebuilt / "manifest.json").write_text(json.dumps(manifest))
    return manifest


def _configure_release(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(release, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)
    # A published desktop release, so the block below is the verified one and
    # not whatever `/var/www/spawnd/desktop` happens to hold on the machine
    # running these tests.
    images = tmp_path / "www" / "desktop"
    _publish_image(images, "darwin-aarch64")
    _publish_image(images, "darwin-x86_64")
    monkeypatch.setattr(
        release,
        "get_settings",
        lambda: SimpleNamespace(
            release_commit=COMMIT,
            mobile_tree=MOBILE_TREE,
            desktop_version=DESKTOP_VERSION,
            desktop_tree=DESKTOP_TREE,
            desktop_dir=images,
            public_url="https://spawnd.dev",
        ),
    )
    mobile = tmp_path / "mobile"
    mobile.mkdir()
    (mobile / "app.json").write_text(json.dumps({"expo": {"version": "0.1.0"}}))
    build = tmp_path / "web" / ".next"
    build.mkdir(parents=True)
    (build / "BUILD_ID").write_text(COMMIT)
    release.refresh()


async def test_release_endpoint_is_public_no_store_and_exact_shape(client, tmp_path, monkeypatch):
    _configure_release(monkeypatch, tmp_path)
    manifest = _stage_manifest(tmp_path)

    response = await client.get("/api/release")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    manifest = {**manifest, "release_counter": None, "signed": False}
    assert response.json() == {
        "server": {"commit": COMMIT, "dirty": False},
        "web": {"build_id": COMMIT},
        "daemon": manifest,
        "mobile": {"tree": MOBILE_TREE, "runtime_version": "0.1.0"},
        "desktop": {
            "version": DESKTOP_VERSION,
            "tree": DESKTOP_TREE,
            "platforms": ["darwin-aarch64", "darwin-x86_64"],
        },
        "protocols": {
            "daemon": "spawn.control.v3",
            "browser": "spawn.v3",
            "alerts": "spawn.alerts.v1",
        },
    }


async def test_release_has_null_daemon_without_a_manifest(client, tmp_path, monkeypatch):
    _configure_release(monkeypatch, tmp_path)

    response = await client.get("/api/release")

    assert response.status_code == 200
    assert response.json()["daemon"] is None


def _configure_computed_desktop(
    monkeypatch,
    tmp_path,
    *,
    clean: bool,
    tree: str | None = DESKTOP_TREE,
) -> None:
    monkeypatch.setattr(release, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)
    # Published, so these tests are about what the checkout can prove and not
    # about whether the image was uploaded — that is `TestDesktopBlockProvesItself`.
    images = tmp_path / "www" / "desktop"
    _publish_image(images, "darwin-aarch64")
    _publish_image(images, "darwin-x86_64")
    monkeypatch.setattr(
        release,
        "get_settings",
        lambda: SimpleNamespace(
            release_commit=COMMIT,
            mobile_tree=MOBILE_TREE,
            desktop_version=None,
            desktop_tree=None,
            desktop_dir=images,
            public_url="https://spawnd.dev",
        ),
    )
    monkeypatch.setattr(release, "_git_path_is_clean", lambda path: clean)
    monkeypatch.setattr(
        release,
        "_git_output",
        lambda *args: tree if args == ("rev-parse", "HEAD:desktop") else None,
    )
    release.refresh()


async def test_release_includes_desktop_identity_when_checkout_is_clean(
    client, tmp_path, monkeypatch
):
    config = tmp_path / "desktop" / "src-tauri" / "tauri.conf.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({"version": DESKTOP_VERSION}))
    _configure_computed_desktop(monkeypatch, tmp_path, clean=True)

    response = await client.get("/api/release")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["desktop"] == {
        "version": DESKTOP_VERSION,
        "tree": DESKTOP_TREE,
        "platforms": ["darwin-aarch64", "darwin-x86_64"],
    }


async def test_release_hides_desktop_identity_when_checkout_is_dirty(client, tmp_path, monkeypatch):
    config = tmp_path / "desktop" / "src-tauri" / "tauri.conf.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({"version": DESKTOP_VERSION}))
    _configure_computed_desktop(monkeypatch, tmp_path, clean=False)

    response = await client.get("/api/release")

    assert response.status_code == 200
    assert response.json()["desktop"] is None


@pytest.mark.parametrize("config_state", ["directory-missing", "config-missing", "malformed"])
async def test_release_hides_desktop_identity_when_directory_or_config_is_unavailable(
    client, tmp_path, monkeypatch, config_state
):
    desktop_tree = None if config_state == "directory-missing" else DESKTOP_TREE
    if config_state != "directory-missing":
        config = tmp_path / "desktop" / "src-tauri" / "tauri.conf.json"
        config.parent.mkdir(parents=True)
        if config_state == "malformed":
            config.write_text("{")
    _configure_computed_desktop(monkeypatch, tmp_path, clean=True, tree=desktop_tree)

    response = await client.get("/api/release")

    assert response.status_code == 200
    assert response.json()["desktop"] is None


async def test_release_tolerates_counter_and_key_id_and_reports_signature(
    client, tmp_path, monkeypatch
):
    _configure_release(monkeypatch, tmp_path)
    manifest = _stage_manifest(tmp_path)
    prebuilt = tmp_path / "daemon" / "target" / "prebuilt"
    manifest.update(release_counter=1_725_000_000, signing_key_id="e65c013f")
    (prebuilt / "manifest.json").write_text(json.dumps(manifest))
    (prebuilt / "manifest.json.sig").write_bytes(b"signature")
    release.refresh()

    response = await client.get("/api/release")
    assert response.status_code == 200
    assert response.json()["daemon"]["release_counter"] == 1_725_000_000
    assert response.json()["daemon"]["signed"] is True

    manifest["release_counter"] = -1
    (prebuilt / "manifest.json").write_text(json.dumps(manifest))
    release.refresh()
    assert (await client.get("/api/release")).json()["daemon"] is None


def test_prebuilt_dir_setting_selects_manifest_and_binary_root(tmp_path, monkeypatch):
    settings = release.get_settings()
    monkeypatch.setattr(settings, "prebuilt_dir", tmp_path)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)

    assert release.prebuilt_root() == tmp_path
    assert release.manifest_path() == tmp_path / "manifest.json"
    assert release.manifest_signature_path() == tmp_path / "manifest.json.sig"


async def test_manifest_hash_mismatch_is_not_advertised_and_logs_once(
    client, tmp_path, monkeypatch, caplog
):
    _configure_release(monkeypatch, tmp_path)
    _stage_manifest(tmp_path, corrupt_worker=True)

    with caplog.at_level("ERROR", logger="spawn.release"):
        first = await client.get("/api/release")
        second = await client.get("/api/release")

    assert first.json()["daemon"] is None
    assert second.json()["daemon"] is None
    mismatches = [record for record in caplog.records if "sha256 mismatch" in record.message]
    assert len(mismatches) == 1


async def test_dirty_checkout_marks_server_dirty_and_hides_mobile_tree(
    client, tmp_path, monkeypatch
):
    monkeypatch.setattr(release, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)
    monkeypatch.setattr(
        release,
        "get_settings",
        lambda: SimpleNamespace(
            release_commit=None,
            mobile_tree=None,
            desktop_version=None,
            desktop_tree=None,
            desktop_dir=tmp_path / "www" / "desktop",
            public_url="https://spawnd.dev",
        ),
    )
    monkeypatch.setattr(
        release,
        "_git_output",
        lambda *args: COMMIT if args == ("rev-parse", "HEAD") else MOBILE_TREE,
    )
    monkeypatch.setattr(release, "_git_path_is_clean", lambda path: False)
    release.refresh()

    response = await client.get("/api/release")

    assert response.json()["server"] == {"commit": COMMIT, "dirty": True}
    assert response.json()["mobile"]["tree"] is None
    assert response.json()["desktop"] is None


def _configure_desktop_publication(
    monkeypatch,
    tmp_path,
    *,
    desktop_dir,
    public_url: str = "https://spawnd.dev",
    version: str = DESKTOP_VERSION,
) -> None:
    """A deployment whose desktop images live somewhere the server can look."""
    monkeypatch.setattr(release, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)
    monkeypatch.setattr(
        release,
        "get_settings",
        lambda: SimpleNamespace(
            release_commit=COMMIT,
            mobile_tree=MOBILE_TREE,
            desktop_version=version,
            desktop_tree=DESKTOP_TREE,
            desktop_dir=desktop_dir,
            public_url=public_url,
        ),
    )
    release.refresh()


def _publish_image(directory, platform: str, version: str = DESKTOP_VERSION) -> None:
    """Put a disk image where `scripts/publish-desktop.sh` would put it.

    The filename is spelled out rather than built with
    `release.desktop_image_name`, because the contract being pinned is the one
    `desktopDownloadUrl` in `web/src/lib/platform.ts` builds a URL to — a test
    that asked the implementation for the name would agree with it either way.
    """
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"SPAWN-D_{version}_{platform}.dmg").write_bytes(b"a notarized disk image")


class TestDesktopBlockProvesItself:
    """`/api/release` may name a Mac build only when its image is really there.

    The daemon block has always worked this way. The desktop block did not,
    and the download page builds its URL straight out of the version it
    advertises — so a deploy that lands before `scripts/publish-desktop.sh`
    used to point the Mac download button at a 404.
    """

    async def test_a_published_release_is_advertised(self, client, tmp_path, monkeypatch):
        images = tmp_path / "www" / "desktop"
        _configure_desktop_publication(monkeypatch, tmp_path, desktop_dir=images)
        _publish_image(images, "darwin-aarch64")
        _publish_image(images, "darwin-x86_64")

        response = await client.get("/api/release")

        assert response.json()["desktop"] == {
            "version": DESKTOP_VERSION,
            "tree": DESKTOP_TREE,
            "platforms": ["darwin-aarch64", "darwin-x86_64"],
        }

    async def test_an_unpublished_release_is_not_advertised(self, client, tmp_path, monkeypatch):
        """The trap, sprung: the directory is there and the image is not."""
        images = tmp_path / "www" / "desktop"
        images.mkdir(parents=True)
        _configure_desktop_publication(monkeypatch, tmp_path, desktop_dir=images)

        response = await client.get("/api/release")

        assert response.json()["desktop"] is None

    async def test_a_version_bump_stops_advertising_until_it_is_published(
        self, client, tmp_path, monkeypatch
    ):
        """The exact shape of the bug: the deploy ships a new version while the
        static origin still holds only the old one's image."""
        images = tmp_path / "www" / "desktop"
        _publish_image(images, "darwin-aarch64", version="0.1.0")
        _publish_image(images, "darwin-x86_64", version="0.1.0")
        _configure_desktop_publication(
            monkeypatch, tmp_path, desktop_dir=images, version="0.2.0"
        )

        response = await client.get("/api/release")

        assert response.json()["desktop"] is None

    async def test_only_the_platforms_on_disk_are_named(self, client, tmp_path, monkeypatch):
        """A half-published release must not offer the Intel link."""
        images = tmp_path / "www" / "desktop"
        _configure_desktop_publication(monkeypatch, tmp_path, desktop_dir=images)
        _publish_image(images, "darwin-aarch64")

        response = await client.get("/api/release")

        assert response.json()["desktop"]["platforms"] == ["darwin-aarch64"]

    async def test_an_intel_only_publication_is_not_advertised_at_all(
        self, client, tmp_path, monkeypatch
    ):
        """Every download surface builds the primary button for Apple silicon
        whatever `platforms` says, so an aarch64-less block is still a 404."""
        images = tmp_path / "www" / "desktop"
        _configure_desktop_publication(monkeypatch, tmp_path, desktop_dir=images)
        _publish_image(images, "darwin-x86_64")

        response = await client.get("/api/release")

        assert response.json()["desktop"] is None

    async def test_no_release_directory_fails_open_and_says_so(
        self, client, tmp_path, monkeypatch, caplog
    ):
        """Nowhere to look is evidence of nothing.

        Withholding here would trade a 404 for a Mac download that quietly
        disappears — which reads as a product decision rather than a broken
        deploy. So the block stands, and the server says it could not check.
        """
        _configure_desktop_publication(
            monkeypatch, tmp_path, desktop_dir=tmp_path / "nowhere"
        )

        with caplog.at_level("ERROR", logger="spawn.release"):
            response = await client.get("/api/release")

        assert response.json()["desktop"] == {
            "version": DESKTOP_VERSION,
            "tree": DESKTOP_TREE,
            "platforms": ["darwin-aarch64", "darwin-x86_64"],
        }
        assert "SPAWN_DESKTOP_DIR" in caplog.text

    async def test_the_warning_is_not_repeated_on_every_request(
        self, client, tmp_path, monkeypatch, caplog
    ):
        """`/api/release` is polled by every open tab and every daemon."""
        _configure_desktop_publication(
            monkeypatch, tmp_path, desktop_dir=tmp_path / "nowhere"
        )

        with caplog.at_level("ERROR", logger="spawn.release"):
            for _ in range(3):
                await client.get("/api/release")

        assert caplog.text.count("SPAWN_DESKTOP_DIR") == 1

    async def test_a_laptop_is_not_nagged_about_a_directory_it_should_not_have(
        self, client, tmp_path, monkeypatch, caplog
    ):
        """Development has no static release origin — `/desktop/` there is Next
        serving `public/desktop`, and `/desktop-build` already answers for it."""
        _configure_desktop_publication(
            monkeypatch,
            tmp_path,
            desktop_dir=tmp_path / "nowhere",
            public_url="http://localhost:8000",
        )

        with caplog.at_level("ERROR", logger="spawn.release"):
            response = await client.get("/api/release")

        assert response.json()["desktop"] is not None
        assert caplog.text == ""

    def test_the_image_name_is_the_one_the_browser_asks_for(self):
        """Pinned against `desktopDownloadUrl` in `web/src/lib/platform.ts`,
        which builds `/desktop/SPAWN-D_<version>_<platform>.dmg`."""
        assert (
            release.desktop_image_name("0.1.0", "darwin-aarch64")
            == "SPAWN-D_0.1.0_darwin-aarch64.dmg"
        )

    def test_nowhere_to_look_and_nothing_there_are_different_answers(self, tmp_path):
        """The distinction the whole design rests on."""
        assert release.published_desktop_platforms("0.1.0", root=tmp_path / "absent") is None
        present = tmp_path / "present"
        present.mkdir()
        assert release.published_desktop_platforms("0.1.0", root=present) == []
