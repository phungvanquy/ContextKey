#!/usr/bin/env python3
"""Build the unsigned Store package on Windows using the Windows SDK.

No signing credentials or Partner Center credentials are needed. Generated
files stay in ignored directories; only an explicit payload is
staged, never the repository or the whole Cargo output directory.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[2]
NS = {
    "f": "http://schemas.microsoft.com/appx/manifest/foundation/windows10",
    "uap": "http://schemas.microsoft.com/appx/manifest/uap/windows10",
}
ASSETS = ("Square44x44Logo.png", "Square150x150Logo.png", "StoreLogo.png")
APP_DLLS = ("WebView2Loader.dll",)
WEBVIEW2 = {"mode": "evergreen", "bundled": False}
# The first Evergreen candidate is expected to be about 5 MiB. Leave headroom
# for app growth while catching accidental runtime bundling in Windows CI.
MAX_MSIX_BYTES = 25 * 1024 * 1024


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def validate_version(value):
    if not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", value):
        raise ValueError("MSIX version must have four numeric components.")
    parts = tuple(int(part) for part in value.split("."))
    if (
        parts[0] == 0
        or parts[3] != 0
        or any(part > 65535 for part in parts)
        or ".".join(map(str, parts)) != value
    ):
        raise ValueError("Store version needs major >= 1, revision 0, and components <= 65535.")


def pe_machine(path):
    with path.open("rb") as binary:
        header = binary.read(64)
        if len(header) != 64 or header[:2] != b"MZ":
            raise ValueError(f"Not a Windows executable: {path}")
        binary.seek(struct.unpack_from("<I", header, 0x3C)[0])
        signature = binary.read(6)
        if len(signature) != 6 or signature[:4] != b"PE\0\0":
            raise ValueError(f"Invalid PE header: {path}")
        return struct.unpack_from("<H", signature, 4)[0]


def package_inputs(root):
    packaging = root / "packaging/windows"
    manifest = ET.parse(packaging / "AppxManifest.xml")
    identity = manifest.find("f:Identity", NS).attrib
    validate_version(identity["Version"])
    if identity["ProcessorArchitecture"] != "x64":
        raise ValueError("This build flow currently supports x64 packages only.")
    return packaging, manifest, identity


def stage_package(root, binary, stage):
    packaging, manifest, identity = package_inputs(root)
    if pe_machine(binary) != 0x8664:
        raise ValueError("ContextKey must be an x64 executable.")
    config = json.loads((root / "src-tauri/tauri.microsoftstore.conf.json").read_text(encoding="utf-8"))
    mode = config["bundle"]["windows"]["webviewInstallMode"]
    if mode != {"type": "skip"}:
        raise ValueError("The Store profile must use the shared Evergreen runtime (type: skip).")
    publisher = manifest.findtext("f:Properties/f:PublisherDisplayName", namespaces=NS)
    if config["bundle"]["publisher"] != publisher:
        raise ValueError("Tauri and MSIX publisher display names must match.")
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    shutil.copy2(binary, stage / "contextkey.exe")
    # Only the optional loader is needed; never sweep stale build-output DLLs
    # (or an old WebView2Runtime folder) into the new Evergreen package.
    for name in APP_DLLS:
        library = binary.parent / name
        if not library.exists():
            continue
        if pe_machine(library) != 0x8664:
            raise ValueError(f"Non-x64 application DLL: {library}")
        shutil.copy2(library, stage / library.name)
    shutil.copy2(packaging / "AppxManifest.xml", stage)
    (stage / "Assets").mkdir()
    for name in ASSETS:
        shutil.copy2(packaging / "Assets" / name, stage / "Assets" / name)
    return identity


def validate_package(package):
    size = package.stat().st_size
    if size > MAX_MSIX_BYTES:
        raise ValueError(f"MSIX exceeds the {MAX_MSIX_BYTES // (1024 * 1024)} MiB size budget: {size} bytes.")
    with zipfile.ZipFile(package) as archive:
        files = archive.infolist()
        names = {entry.filename for entry in files}
        required = {
            "AppxManifest.xml", "AppxBlockMap.xml", "[Content_Types].xml", "contextkey.exe",
            *(f"Assets/{name}" for name in ASSETS),
        }
        allowed = required | set(APP_DLLS)
        if not required.issubset(names) or names - allowed or len(names) != len(files):
            raise ValueError("The output must be a complete unsigned Evergreen package with only the allowed payload.")
        unpacked = sum(entry.file_size for entry in files)
        print(f"MSIX size: {size:,} bytes compressed; {unpacked:,} bytes unpacked.")
        for entry in sorted(files, key=lambda item: item.compress_size, reverse=True)[:5]:
            print(f"  {entry.filename}: {entry.compress_size:,} compressed / {entry.file_size:,} unpacked bytes")
    return {"packageSizeBytes": size, "uncompressedSizeBytes": unpacked}


def find_makeappx():
    installed = shutil.which("makeappx.exe")
    if installed:
        return Path(installed)
    sdk = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Windows Kits/10/bin"
    candidates = [path for path in sdk.glob("*/x64/makeappx.exe") if re.fullmatch(r"\d+(\.\d+){3}", path.parents[1].name)]
    if not candidates:
        raise FileNotFoundError("Install the Windows 10/11 SDK with MakeAppx.exe.")
    return max(candidates, key=lambda path: tuple(map(int, path.parents[1].name.split("."))))


def build_package(root):
    work = root / "src-tauri/target/msix"
    stage = work / "stage"
    identity = stage_package(
        root,
        root / "src-tauri/target/release/contextkey.exe",
        stage,
    )
    output = work / "output"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    package = output / f"{identity['Name']}_{identity['Version']}_x64.msix"
    # Keep MakeAppx semantic validation enabled (do not add /nv).
    subprocess.run([str(find_makeappx()), "pack", "/o", "/h", "SHA256", "/d", str(stage), "/p", str(package)], check=True)
    sizes = validate_package(package)
    digest = sha256(package)
    (output / f"{package.name}.sha256").write_text(f"{digest}  {package.name}\n", encoding="utf-8")
    app_config = json.loads((root / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    info = {
        "identity": identity,
        "appVersion": app_config["version"],
        "commit": os.environ.get("GITHUB_SHA", "local build"),
        "webview2": WEBVIEW2,
        **sizes,
        "sha256": digest,
        "signed": False,
    }
    (output / "build-info.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print(f"Created {package}\nSHA-256: {digest}")
    print("Upload the .msix to Partner Center after Windows testing. Microsoft signs it after certification.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("package",))
    parser.parse_args()
    if os.name != "nt":
        parser.error("MSIX packaging requires Windows.")
    build_package(ROOT)


if __name__ == "__main__":
    main()
