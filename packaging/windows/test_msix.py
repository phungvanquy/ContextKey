"""Portable checks for Store packaging; MakeAppx validation runs in Windows CI."""

import json
from pathlib import Path
import shutil
import struct
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

import build_msix as msix


def write_pe(path, machine=0x8664):
    header = bytearray(64)
    header[:2] = b"MZ"
    struct.pack_into("<I", header, 0x3C, len(header))
    path.write_bytes(header + b"PE\0\0" + struct.pack("<H", machine))


class PackageInputsTests(unittest.TestCase):
    def test_partner_center_identity_and_manifest_assets(self):
        packaging, manifest, identity = msix.package_inputs(msix.ROOT)
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
        shutil.copy2(msix.ROOT / "src-tauri/tauri.conf.json", self.root / "src-tauri")
        self.stage = self.root / "src-tauri/target/msix/stage"

    def stage_files(self):
        return msix.stage_package(self.root, self.binary, self.stage)

    def test_stages_complete_payload_without_unrelated_build_files(self):
        (self.binary.parent / ".env").write_text("secret", encoding="utf-8")
        (self.binary.parent / "contextkey.pdb").write_bytes(b"debug symbols")
        write_pe(self.binary.parent / "unrelated.dll", 0xAA64)
        write_pe(self.binary.parent / "WebView2Loader.dll")
        # Old runtime downloads may survive in a developer checkout or cache.
        for runtime in (self.root / "src-tauri/WebView2Runtime", self.binary.parent / "WebView2Runtime"):
            runtime.mkdir()
            write_pe(runtime / "msedgewebview2.exe")
        self.stage.mkdir(parents=True)
        (self.stage / "obsolete-file.txt").write_text("old build", encoding="utf-8")
        self.stage_files()
        self.assertEqual(
            {path.name for path in self.stage.iterdir()},
            {"contextkey.exe", "WebView2Loader.dll", "AppxManifest.xml", "Assets"},
        )
        self.assertEqual({path.name for path in (self.stage / "Assets").iterdir()}, set(msix.ASSETS))

    def test_rejects_wrong_app_architecture(self):
        write_pe(self.binary, 0xAA64)
        with self.assertRaisesRegex(ValueError, "x64"):
            self.stage_files()

    def test_rejects_invalid_executable(self):
        self.binary.write_text("not an executable", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Windows executable"):
            self.stage_files()

    def test_rejects_runtime_profiles_that_disagree_with_evergreen_payload(self):
        path = self.root / "src-tauri/tauri.microsoftstore.conf.json"
        config = json.loads(path.read_text(encoding="utf-8"))
        for mode in (
            {"type": "fixedRuntime", "path": "WebView2Runtime"},
            {"type": "downloadBootstrapper"},
        ):
            with self.subTest(mode=mode):
                config["bundle"]["windows"]["webviewInstallMode"] = mode
                path.write_text(json.dumps(config), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "Evergreen"):
                    self.stage_files()

    def test_rejects_wrong_architecture_loader(self):
        write_pe(self.binary.parent / "WebView2Loader.dll", 0x14C)
        with self.assertRaisesRegex(ValueError, "Non-x64"):
            self.stage_files()

    def test_build_records_evergreen_mode_checksum_and_measured_sizes(self):
        def makeappx(command, check):
            self.assertTrue(check)
            self.assertNotIn("/nv", command)
            self.assertNotIn("/nc", command)
            package = Path(command[command.index("/p") + 1])
            with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
                for path in self.stage.rglob("*"):
                    if path.is_file():
                        archive.write(path, path.relative_to(self.stage).as_posix())
                archive.writestr("AppxBlockMap.xml", "block map fixture")
                archive.writestr("[Content_Types].xml", "content types fixture")

        with patch.object(msix, "find_makeappx", return_value=Path("makeappx.exe")), patch.object(msix.subprocess, "run", side_effect=makeappx):
            msix.build_package(self.root)
        output = self.stage.parent / "output"
        package = next(output.glob("*.msix"))
        info = json.loads((output / "build-info.json").read_text())
        self.assertEqual(info["webview2"], {"mode": "evergreen", "bundled": False})
        self.assertEqual(info["packageSizeBytes"], package.stat().st_size)
        with zipfile.ZipFile(package) as archive:
            self.assertEqual(info["uncompressedSizeBytes"], sum(f.file_size for f in archive.infolist()))
        self.assertEqual(info["sha256"], msix.sha256(package))
        self.assertEqual((output / f"{package.name}.sha256").read_text(), f"{info['sha256']}  {package.name}\n")


class ArchiveValidationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.package = Path(self.temporary.name) / "app.msix"
        self.files = {
            "contextkey.exe": b"application fixture",
            "AppxManifest.xml": b"manifest fixture",
            "AppxBlockMap.xml": b"block map fixture",
            "[Content_Types].xml": b"content types fixture",
            **{f"Assets/{name}": b"logo fixture" for name in msix.ASSETS},
        }

    def write_archive(self):
        with zipfile.ZipFile(self.package, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, contents in self.files.items():
                archive.writestr(name, contents)

    def test_accepts_evergreen_payload_with_or_without_optional_loader(self):
        for loader in (False, True):
            with self.subTest(loader=loader):
                if loader:
                    self.files["WebView2Loader.dll"] = b"loader fixture"
                self.write_archive()
                sizes = msix.validate_package(self.package)
                self.assertEqual(sizes["packageSizeBytes"], self.package.stat().st_size)
                self.assertEqual(sizes["uncompressedSizeBytes"], sum(map(len, self.files.values())))

    def test_rejects_runtime_symbols_unknown_dll_and_signature(self):
        for name in ("WebView2Runtime/msedgewebview2.exe", "msedge.dll", "contextkey.pdb", "AppxSignature.p7x"):
            with self.subTest(name=name):
                self.files[name] = b"unwanted payload"
                self.write_archive()
                with self.assertRaisesRegex(ValueError, "allowed payload"):
                    msix.validate_package(self.package)
                del self.files[name]

    def test_rejects_incomplete_package(self):
        for name in list(self.files):
            with self.subTest(name=name):
                contents = self.files.pop(name)
                self.write_archive()
                with self.assertRaisesRegex(ValueError, "complete unsigned"):
                    msix.validate_package(self.package)
                self.files[name] = contents

    def test_rejects_duplicate_entries(self):
        self.write_archive()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.package, "a") as archive:
                archive.writestr("contextkey.exe", "duplicate")
        with self.assertRaisesRegex(ValueError, "allowed payload"):
            msix.validate_package(self.package)

    def test_rejects_package_above_size_budget(self):
        with self.package.open("wb") as output:
            output.seek(msix.MAX_MSIX_BYTES)
            output.write(b"\0")
        with self.assertRaisesRegex(ValueError, "size budget"):
            msix.validate_package(self.package)


if __name__ == "__main__":
    unittest.main()
