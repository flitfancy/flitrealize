#!/usr/bin/env python3
"""Refresh English source hashes embedded in the Chinese mirror."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PATTERN = re.compile(r"英文源文件 SHA-256：`[0-9A-F]{64}`")


def pairs() -> list[tuple[Path, Path]]:
    result = [(ROOT / "SKILL.md", ROOT / "docs/zh-CN/SKILL.zh-CN.md")]
    for source in sorted((ROOT / "references").rglob("*.md")):
        relative = source.relative_to(ROOT / "references")
        result.append((source, ROOT / "docs/zh-CN/references" / relative))
    return result


def main() -> int:
    for source, translation in pairs():
        if not translation.is_file():
            raise FileNotFoundError(translation)
        digest = hashlib.sha256(source.read_bytes()).hexdigest().upper()
        text = translation.read_text(encoding="utf-8")
        updated, count = PATTERN.subn(f"英文源文件 SHA-256：`{digest}`", text, count=1)
        if count != 1:
            raise ValueError(f"Missing or duplicate source hash marker: {translation}")
        translation.write_text(updated, encoding="utf-8", newline="\n")
        print(f"updated {translation.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
