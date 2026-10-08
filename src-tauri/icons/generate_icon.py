#!/usr/bin/env python3
"""Resize the supplied ContextKey logo into the app's PNG and Windows ICO.

The original image is kept in brand.png. Source:
https://chatgpt.com/s/m_6ac829e4267881919d8f071317581827

Requires Pillow. The generated PNG/ICO are committed; no build-time dependency.
    python src-tauri/icons/generate_icon.py
"""

from pathlib import Path

from PIL import Image, ImageOps


ICON_DIR = Path(__file__).resolve().parent
PNG_SIZE = (512, 512)
ICO_SIZES = [(size, size) for size in (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)]


def build():
    """Preserve the artwork and aspect ratio; pad non-square sources if needed."""
    with Image.open(ICON_DIR / "brand.png") as source:
        icon = ImageOps.exif_transpose(source).convert("RGBA")
    # Tauri expects an RGBA PNG, even when the artwork is fully opaque.
    return ImageOps.pad(
        icon,
        PNG_SIZE,
        method=Image.Resampling.LANCZOS,
        color=(0, 0, 0, 0),
    )


def main():
    icon = build()
    icon.save(ICON_DIR / "icon.png", optimize=True)
    icon.save(ICON_DIR / "icon.ico", sizes=ICO_SIZES)
    print(f"wrote icon.png {PNG_SIZE} and icon.ico {ICO_SIZES}")


if __name__ == "__main__":
    main()
