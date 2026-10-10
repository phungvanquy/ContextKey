#!/usr/bin/env python3
"""Build the unsigned Store package on Windows using the Windows SDK.

No signing credentials or Partner Center credentials are needed. All downloads
and generated files stay in ignored directories; only an explicit payload is
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
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[2]
NS = {
    "f": "http://schemas.microsoft.com/appx/manifest/foundation/windows10",
    "uap": "http://schemas.microsoft.com/appx/manifest/uap/windows10",
}


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
    pin = json.loads((packaging / "webview2.json").read_text(encoding="utf-8"))
    if pin["architecture"] != "x64" or not re.fullmatch(r"[a-f0-9]{64}", pin["sha256"]):
        raise ValueError("Invalid WebView2 architecture or SHA-256 pin.")
    return packaging, manifest, identity, pin


def download_verified(url, destination, expected_hash):
    if not destination.exists():
        temporary = destination.with_suffix(".download")
        try:
            with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            if sha256(temporary) != expected_hash:
                raise ValueError("WebView2 download SHA-256 does not match the pinned value.")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    if sha256(destination) != expected_hash:
        raise ValueError(f"Invalid cached runtime; remove {destination} and retry.")


def prepare_runtime(root):
    _, _, _, pin = package_inputs(root)
    work = root / "src-tauri/target/msix"
    work.mkdir(parents=True, exist_ok=True)
    archive = work / f"WebView2-{pin['version']}-x64.cab"
    download_verified(pin["url"], archive, pin["sha256"])
    with tempfile.TemporaryDirectory(dir=work) as temporary:
        extracted = Path(temporary)
        # Use the Windows utility explicitly; PowerShell's expand alias is unrelated.
        expand = Path(os.environ["SystemRoot"]) / "System32/expand.exe"
        subprocess.run([str(expand), str(archive), "-F:*", str(extracted)], check=True)
        executables = list(extracted.rglob("msedgewebview2.exe"))
        if len(executables) != 1 or pe_machine(executables[0]) != 0x8664:
            raise ValueError("The runtime archive must contain exactly one x64 WebView2 runtime.")
        destination = root / "src-tauri/WebView2Runtime"
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(executables[0].parent, destination)
        (destination / "contextkey-runtime.json").write_text(json.dumps(pin), encoding="utf-8")
    print(f"Prepared WebView2 {pin['version']} (SHA-256 verified).")


def stage_package(root, binary, runtime, stage):
    packaging, manifest, identity, pin = package_inputs(root)
    if pe_machine(binary) != 0x8664 or pe_machine(runtime / "msedgewebview2.exe") != 0x8664:
        raise ValueError("Both ContextKey and WebView2 must be x64 executables.")
    runtime_pin = json.loads((runtime / "contextkey-runtime.json").read_text(encoding="utf-8"))
    if runtime_pin != pin:
        raise ValueError("Bundled WebView2 is stale; run the runtime preparation step again.")
    config = json.loads((root / "src-tauri/tauri.microsoftstore.conf.json").read_text(encoding="utf-8"))
    mode = config["bundle"]["windows"]["webviewInstallMode"]
    if mode != {"type": "fixedRuntime", "path": "WebView2Runtime"}:
        raise ValueError("The Tauri runtime path must match the MSIX payload layout.")
    publisher = manifest.findtext("f:Properties/f:PublisherDisplayName", namespaces=NS)
    if config["bundle"]["publisher"] != publisher:
        raise ValueError("Tauri and MSIX publisher display names must match.")
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    shutil.copy2(binary, stage / "contextkey.exe")
    # Some WebView2 loader configurations produce an adjacent DLL.
    for library in binary.parent.glob("*.dll"):
        if pe_machine(library) != 0x8664:
            raise ValueError(f"Non-x64 application DLL: {library}")
        shutil.copy2(library, stage / library.name)
    shutil.copy2(packaging / "AppxManifest.xml", stage)
    shutil.copytree(packaging / "Assets", stage / "Assets")
    shutil.copytree(runtime, stage / "WebView2Runtime")
    return identity


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
        root / "src-tauri/WebView2Runtime",
        stage,
    )
    output = work / "output"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    package = output / f"{identity['Name']}_{identity['Version']}_x64.msix"
    # Keep MakeAppx semantic validation enabled (do not add /nv).
    subprocess.run([str(find_makeappx()), "pack", "/o", "/h", "SHA256", "/d", str(stage), "/p", str(package)], check=True)
    with zipfile.ZipFile(package) as archive:
        names = set(archive.namelist())
        required = {"AppxManifest.xml", "AppxBlockMap.xml", "contextkey.exe", "WebView2Runtime/msedgewebview2.exe"}
        if not required.issubset(names) or "AppxSignature.p7x" in names:
            raise ValueError("The output must be a complete unsigned Store package.")
    digest = sha256(package)
    (output / f"{package.name}.sha256").write_text(f"{digest}  {package.name}\n", encoding="utf-8")
    app_config = json.loads((root / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    _, _, _, pin = package_inputs(root)
    info = {
        "identity": identity,
        "appVersion": app_config["version"],
        "commit": os.environ.get("GITHUB_SHA", "local build"),
        "webview2": pin,
        "sha256": digest,
        "signed": False,
    }
    (output / "build-info.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print(f"Created {package}\nSHA-256: {digest}")
    print("Upload the .msix to Partner Center after Windows testing. Microsoft signs it after certification.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("runtime", "package"))
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("Runtime extraction and MSIX packaging require Windows.")
    if args.command == "runtime":
        prepare_runtime(ROOT)
    else:
        build_package(ROOT)


if __name__ == "__main__":
    main()
