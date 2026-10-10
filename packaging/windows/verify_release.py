#!/usr/bin/env python3
"""Check that release artifacts belong to the tagged app build before publishing."""

import hashlib
import json
import os
from pathlib import Path
import tomllib
import xml.etree.ElementTree as ET


def verify_release(root, assets, tag, commit):
    app = json.loads((root / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    cargo = tomllib.loads((root / "src-tauri/Cargo.toml").read_text(encoding="utf-8"))
    version = app["version"]
    if tag != f"v{version}" or cargo["package"]["version"] != version:
        raise ValueError("Release tag, Cargo version, and Tauri version must agree.")
    if not (root / f"docs/releases/{tag}.md").is_file():
        raise ValueError("Release notes are required before publication.")
    info = json.loads((assets / "build-info.json").read_text(encoding="utf-8"))
    if info["commit"] != commit or info["appVersion"] != version or info["signed"] is not False:
        raise ValueError("The MSIX must be the unsigned candidate from this exact app commit.")
    manifest = ET.parse(root / "packaging/windows/AppxManifest.xml")
    identity = manifest.find("{http://schemas.microsoft.com/appx/manifest/foundation/windows10}Identity").attrib
    if info["identity"] != identity:
        raise ValueError("MSIX build metadata does not match the release's Store identity.")
    package_name = f"{identity['Name']}_{identity['Version']}_x64.msix"
    required = {
        "contextkey.exe",
        f"ContextKey_{version}_x64-setup.exe",
        package_name,
        f"{package_name}.sha256",
        "build-info.json",
    }
    if {path.name for path in assets.iterdir()} != required:
        raise ValueError("Release artifacts are missing or contain unexpected files.")
    sums = []
    for name in sorted(required):
        path = assets / name
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Release artifact is empty or not a file: {name}")
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if name == package_name:
            sidecar = (assets / f"{name}.sha256").read_text(encoding="utf-8").strip()
            if digest != info["sha256"] or sidecar != f"{digest}  {name}":
                raise ValueError("MSIX checksum verification failed.")
        sums.append(f"{digest}  {name}\n")
    (assets / "SHA256SUMS.txt").write_text("".join(sums), encoding="utf-8")
    print(f"Verified {tag}, source commit {commit}, and all five release artifacts.")


if __name__ == "__main__":
    verify_release(Path.cwd(), Path("release-assets"), os.environ["RELEASE_TAG"], os.environ["GITHUB_SHA"])
