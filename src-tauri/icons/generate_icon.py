#!/usr/bin/env python3
"""Resize the supplied ContextKey logo into desktop and frontend assets.

The original image is kept in brand.png. Source:
https://chatgpt.com/s/m_6ac9ab048d608191b153a164b7fffd0c

Requires Pillow. The generated PNG/ICO are committed; no build-time dependency.
    python src-tauri/icons/generate_icon.py
"""

from pathlib import Path

from PIL import Image, ImageOps


ICON_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = ICON_DIR.parent.parent / "frontend"
STORE_ASSET_DIR = ICON_DIR.parent.parent / "packaging" / "windows" / "Assets"
PNG_SIZE = (512, 512)
FRONTEND_SIZE = (128, 128)
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
    icon.resize(FRONTEND_SIZE, Image.Resampling.LANCZOS).save(
        FRONTEND_DIR / "brand.png", optimize=True
    )
    STORE_ASSET_DIR.mkdir(parents=True, exist_ok=True)
    for name, size in (("StoreLogo", 50), ("Square44x44Logo", 44), ("Square150x150Logo", 150)):
        icon.resize((size, size), Image.Resampling.LANCZOS).save(
            STORE_ASSET_DIR / f"{name}.png", optimize=True
        )
    print(f"wrote icon.png {PNG_SIZE}, icon.ico {ICO_SIZES}, and frontend/brand.png {FRONTEND_SIZE}")
    print(f"wrote Microsoft Store logos in {STORE_ASSET_DIR}")


if __name__ == "__main__":
    main()
