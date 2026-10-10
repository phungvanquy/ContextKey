"""Portable checks for Store packaging; MakeAppx validation runs in Windows CI."""

import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import tempfile
import unittest
from unittest.mock import patch

import build_msix as msix


def write_pe(path, machine=0x8664):
    header = bytearray(64)
    header[:2] = b"MZ"
    struct.pack_into("<I", header, 0x3C, len(header))
    path.write_bytes(header + b"PE\0\0" + struct.pack("<H", machine))


class PackageInputsTests(unittest.TestCase):
    def test_partner_center_identity_and_manifest_assets(self):
        packaging, manifest, identity, _ = msix.package_inputs(msix.ROOT)
        self.assertEqual(identity["Name"], "ITMO.ContextKey")
        self.assertEqual(identity["Publisher"], "CN=B4AAB21C-9EB8-42AA-87B3-8F966E39D731")
        self.assertEqual(manifest.findtext("f:Properties/f:PublisherDisplayName", namespaces=msix.NS), "ITMOvnteam")
        application = manifest.find("f:Applications/f:Application", msix.NS)
        self.assertEqual(application.attrib["EntryPoint"], "Windows.FullTrustApplication")
        self.assertEqual(application.attrib["Executable"], "contextkey.exe")
        capability = manifest.find("f:Capabilities/*", msix.NS)
        self.assertEqual(capability.attrib["Name"], "runFullTrust")
        visual = application.find("uap:VisualElements", msix.NS)
        logos = {
            manifest.findtext("f:Properties/f:Logo", namespaces=msix.NS): 50,
            visual.attrib["Square44x44Logo"]: 44,
            visual.attrib["Square150x150Logo"]: 150,
        }
        for name, size in logos.items():
            data = packaging.joinpath(*name.split("\\")).read_bytes()
            self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack(">II", data[16:24]), (size, size))

    def test_store_version_rejects_invalid_upload_versions(self):
        for version in ("0.4.0.0", "1.0.0.1", "1.0.0", "65536.0.0.0", "1.0.-1.0", "01.0.0.0", "1.0.0.0-beta"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                msix.validate_version(version)
        for version in ("1.0.0.0", "1.2.345.0", "65535.65535.65535.0"):
            msix.validate_version(version)


class StagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        shutil.copytree(msix.ROOT / "packaging/windows", self.root / "packaging/windows", ignore=shutil.ignore_patterns("__pycache__"))
        release = self.root / "src-tauri/target/release"
        release.mkdir(parents=True)
        self.binary = release / "contextkey.exe"
        write_pe(self.binary)
        shutil.copy2(msix.ROOT / "src-tauri/tauri.microsoftstore.conf.json", self.root / "src-tauri")
        self.runtime = self.root / "src-tauri/WebView2Runtime"
        self.runtime.mkdir()
        write_pe(self.runtime / "msedgewebview2.exe")
        _, _, _, self.pin = msix.package_inputs(self.root)
        (self.runtime / "contextkey-runtime.json").write_text(json.dumps(self.pin), encoding="utf-8")
        (self.runtime / "locales").mkdir()
        (self.runtime / "locales/en-US.pak").write_bytes(b"runtime resource")
        self.stage = self.root / "src-tauri/target/msix/stage"

    def stage_files(self):
        return msix.stage_package(self.root, self.binary, self.runtime, self.stage)

    def test_stages_complete_payload_without_unrelated_build_files(self):
        (self.binary.parent / ".env").write_text("secret", encoding="utf-8")
        (self.binary.parent / "contextkey.pdb").write_bytes(b"debug symbols")
        write_pe(self.binary.parent / "WebView2Loader.dll")
        self.stage.mkdir(parents=True)
        (self.stage / "obsolete-file.txt").write_text("old build", encoding="utf-8")
        self.stage_files()
        self.assertEqual(
            {path.name for path in self.stage.iterdir()},
            {"contextkey.exe", "WebView2Loader.dll", "AppxManifest.xml", "Assets", "WebView2Runtime"},
        )
        self.assertEqual((self.stage / "WebView2Runtime/locales/en-US.pak").read_bytes(), b"runtime resource")

    def test_rejects_wrong_app_or_runtime_architecture(self):
        for path in (self.binary, self.runtime / "msedgewebview2.exe"):
            with self.subTest(path=path):
                write_pe(path, 0xAA64)
                with self.assertRaisesRegex(ValueError, "x64"):
                    self.stage_files()
                write_pe(path)

    def test_rejects_invalid_executable(self):
        self.binary.write_text("not an executable", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Windows executable"):
            self.stage_files()

    def test_rejects_stale_bundled_runtime(self):
        pin = {**self.pin, "version": "1.2.3.4"}
        (self.runtime / "contextkey-runtime.json").write_text(json.dumps(pin), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "stale"):
            self.stage_files()

    def test_rejects_wrong_runtime_location_in_tauri_config(self):
        path = self.root / "src-tauri/tauri.microsoftstore.conf.json"
        config = json.loads(path.read_text(encoding="utf-8"))
        config["bundle"]["windows"]["webviewInstallMode"]["path"] = "missing-runtime"
        path.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "runtime path"):
            self.stage_files()

    def test_rejects_wrong_architecture_loader(self):
        write_pe(self.binary.parent / "WebView2Loader.dll", 0x14C)
        with self.assertRaisesRegex(ValueError, "Non-x64"):
            self.stage_files()


class RuntimeDownloadTests(unittest.TestCase):
    def test_accepts_verified_download_and_reuses_verified_cache(self):
        contents = b"verified runtime fixture"
        digest = hashlib.sha256(contents).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime.cab"
            with patch.object(msix.urllib.request, "urlopen", return_value=io.BytesIO(contents)) as download:
                msix.download_verified("https://example.invalid/runtime.cab", path, digest)
                msix.download_verified("https://example.invalid/runtime.cab", path, digest)
                download.assert_called_once()
            self.assertEqual(path.read_bytes(), contents)

    def test_rejects_corrupt_download_without_promoting_it_to_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime.cab"
            with patch.object(msix.urllib.request, "urlopen", return_value=io.BytesIO(b"corrupt")):
                with self.assertRaisesRegex(ValueError, "SHA-256"):
                    msix.download_verified("https://example.invalid/runtime.cab", path, "0" * 64)
            self.assertFalse(path.exists())
            self.assertFalse(path.with_suffix(".download").exists())

    def test_rejects_modified_cached_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime.cab"
            path.write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "Invalid cached runtime"):
                msix.download_verified("https://example.invalid/runtime.cab", path, "0" * 64)


if __name__ == "__main__":
    unittest.main()
