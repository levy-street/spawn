#!/usr/bin/env python3
"""Exercise cleanup boundaries without an Android SDK or a real runner cache."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "compact_android", Path(__file__).with_name("compact-android-build.py")
)
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class AndroidBuildCleanup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="android-cleanup-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.build = self.root / "native-app"
        self.release = self.build / "android/app/build/outputs/apk/release"
        self.release.mkdir(parents=True)
        self.modules = self.build / "node_modules"
        self.modules.mkdir()
        (self.modules / "compiler-cache").write_text("disposable")
        self.artifact = self.release / "app-release.apk"
        self.artifact.write_bytes(b"exact candidate APK bytes")
        self.pointer = self.build / "native-artifact.txt"
        self.pointer.write_text(str(self.artifact) + "\n")
        self.manifest = self.build / "acceptance-build.json"
        self.manifest.write_text(json.dumps({
            "candidate_commit": "a" * 40,
            "source_clean": True,
            "platform": "android",
            "app_id": "dev.spawnd.acceptance",
            "configuration": "Release",
        }))
        self.external = self.root / "preserved-fixture-and-sdk"
        self.external.mkdir()
        (self.external / "sentinel").write_text("preserve")

    def assert_refused(self, build=None):
        with self.assertRaises((ValueError, FileNotFoundError)):
            cleanup.compact(build or self.build, self.root)
        self.assertTrue((self.build / "android").exists())
        self.assertTrue(self.modules.exists())
        self.assertFalse((self.build / "native-build").exists())
        self.assertEqual((self.external / "sentinel").read_text(), "preserve")

    def test_preserves_apk_inode_manifest_and_external_trees(self):
        inode = self.artifact.stat().st_ino
        manifest = self.manifest.read_bytes()
        # rmtree must unlink a nested link, never follow it into the fixture.
        (self.modules / "external-link").symlink_to(self.external, target_is_directory=True)
        cleanup.compact(self.build, self.root)
        staged = Path(self.pointer.read_text().strip())
        self.assertEqual(staged, self.build / "native-build/acceptance.apk")
        self.assertEqual(staged.read_bytes(), b"exact candidate APK bytes")
        self.assertEqual(staged.stat().st_ino, inode)
        self.assertEqual(self.manifest.read_bytes(), manifest)
        self.assertFalse((self.build / "android").exists())
        self.assertFalse(self.modules.exists())
        self.assertEqual((self.external / "sentinel").read_text(), "preserve")

    def test_refuses_other_build_directory(self):
        self.assert_refused(self.external)

    def test_refuses_symlinked_build(self):
        alias = self.root / "alias"
        alias.symlink_to(self.build, target_is_directory=True)
        self.assert_refused(alias)

    def test_refuses_symlinked_generated_tree(self):
        (self.modules / "compiler-cache").unlink()
        self.modules.rmdir()
        self.modules.symlink_to(self.external, target_is_directory=True)
        self.assert_refused()

    def test_refuses_external_apk(self):
        apk = self.external / "outside.apk"
        apk.write_bytes(b"unrelated")
        self.pointer.write_text(str(apk) + "\n")
        self.assert_refused()

    def test_refuses_missing_apk(self):
        self.artifact.unlink()
        self.assert_refused()

    def test_refuses_symlinked_artifact_pointer(self):
        outside = self.external / "native-artifact.txt"
        original = str(self.artifact) + "\n"
        outside.write_text(original)
        self.pointer.unlink()
        self.pointer.symlink_to(outside)
        self.assert_refused()
        self.assertEqual(outside.read_text(), original)

    def test_refuses_multiple_apks(self):
        self.pointer.write_text(str(self.artifact) + "\n" + str(self.artifact) + "\n")
        self.assert_refused()

    def test_refuses_wrong_platform_or_dirty_source(self):
        original = json.loads(self.manifest.read_text())
        for changes in ({"platform": "ios"}, {"source_clean": False}, {"candidate_commit": "short"}):
            with self.subTest(changes=changes):
                self.manifest.write_text(json.dumps(original | changes))
                self.assert_refused()


if __name__ == "__main__":
    unittest.main()
