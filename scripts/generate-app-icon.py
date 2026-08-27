#!/usr/bin/env python3
"""Ensure Playout app icon master PNG is present for Tauri icon generation."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "desktop" / "src-tauri" / "icons"
PNG = ICONS / "app-icon-source.png"
SVG = ICONS / "app-icon-source.svg"


def main() -> None:
    if not PNG.exists():
        raise SystemExit(
            f"Missing {PNG}. Export a 1024x1024 PNG from {SVG.name} "
            "or copy the design master into that path."
        )
    print(f"using {PNG}")


if __name__ == "__main__":
    main()
