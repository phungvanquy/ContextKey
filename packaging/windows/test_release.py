"""Exercise publication gates without publishing anything or needing Windows."""

import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET

import build_msix
from verify_release import verify_release


class ReleaseVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        source = build_msix.ROOT
        version = json.loads((source / "src-tauri/tauri.conf.json").read_text())["version"]
        self.tag = f"v{version}"
        self.commit = "a" * 40
        for name in (
            "src-tauri/Cargo.toml",
            "src-tauri/tauri.conf.json",
            "packaging/windows/AppxManifest.xml",
            f"docs/releases/{self.tag}.md",
        ):
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, destination)
        identity = ET.parse(self.root / "packaging/windows/AppxManifest.xml").find("f:Identity", build_msix.NS).attrib
        self.assets = self.root / "release-assets"
        self.assets.mkdir()
        self.package_name = f"{identity['Name']}_{identity['Version']}_x64.msix"
        self.package = self.assets / self.package_name
        self.package.write_bytes(b"MSIX test fixture")
        digest = hashlib.sha256(self.package.read_bytes()).hexdigest()
        (self.assets / f"{self.package_name}.sha256").write_text(f"{digest}  {self.package_name}\n")
        self.info = {"commit": self.commit, "appVersion": version, "signed": False, "identity": identity, "sha256": digest}
        self.write_info()
        (self.assets / "contextkey.exe").write_bytes(b"EXE test fixture")
        self.installer = self.assets / f"ContextKey_{version}_x64-setup.exe"
        self.installer.write_bytes(b"Installer test fixture")

    def write_info(self):
        (self.assets / "build-info.json").write_text(json.dumps(self.info))

    def verify(self):
        verify_release(self.root, self.assets, self.tag, self.commit)

    def test_complete_matching_artifacts_produce_checksum_manifest(self):
        self.verify()
        lines = (self.assets / "SHA256SUMS.txt").read_text().splitlines()
        self.assertEqual(len(lines), 5)
        for line in lines:
            digest, name = line.split("  ", 1)
            self.assertEqual(digest, hashlib.sha256((self.assets / name).read_bytes()).hexdigest())

    def test_mismatched_tag_is_rejected(self):
        self.tag = "v999.0.0"
        with self.assertRaisesRegex(ValueError, "must agree"):
            self.verify()

    def test_msix_from_another_commit_is_rejected(self):
        self.info["commit"] = "b" * 40
        self.write_info()
        with self.assertRaisesRegex(ValueError, "exact app commit"):
            self.verify()

    def test_corrupted_msix_is_rejected(self):
        self.package.write_bytes(b"changed after packaging")
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.verify()

    def test_missing_installer_is_rejected(self):
        self.installer.unlink()
        with self.assertRaisesRegex(ValueError, "missing"):
            self.verify()

    def test_unexpected_files_are_rejected(self):
        (self.assets / "unrelated.txt").write_text("unrelated build output")
        with self.assertRaisesRegex(ValueError, "unexpected"):
            self.verify()

    def test_wrong_store_identity_is_rejected(self):
        self.info["identity"]["Publisher"] = "CN=WrongPublisher"
        self.write_info()
        with self.assertRaisesRegex(ValueError, "Store identity"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
