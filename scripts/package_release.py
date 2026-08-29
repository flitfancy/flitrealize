#!/usr/bin/env python3
"""Build a deterministic runtime-only FlitRealize release archive."""

from __future__ import annotations

import hashlib
import subprocess
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
ARCHIVE_ROOT = "flitrealize"
FIXED_TIME = (2026, 1, 1, 0, 0, 0)
ZIP_CREATE_SYSTEM = 3
ZIP_VERSION = 20


def runtime_files() -> list[Path]:
    return [
        ROOT / "LICENSE",
        ROOT / "VERSION",
        ROOT / "SKILL.md",
        ROOT / "agents/openai.yaml",
        ROOT / "scripts/action-runner.mjs",
        ROOT / "scripts/eda-host.mjs",
        ROOT / "scripts/actions/manifest.json",
        *sorted((ROOT / "scripts/actions").rglob("*.js")),
        *sorted((ROOT / "schemas").glob("*.json")),
        *sorted((ROOT / "references").rglob("*.md")),
    ]


def write_archive(
    archive: Path,
    sources: list[Path],
    *,
    root: Path = ROOT,
    archive_root: str = ARCHIVE_ROOT,
) -> None:
    """Write a byte-reproducible, platform-independent runtime ZIP."""
    archive.parent.mkdir(parents=True, exist_ok=True)
    ordered_sources = sorted(
        sources,
        key=lambda source: source.relative_to(root).as_posix(),
    )

    with zipfile.ZipFile(
        archive,
        "w",
        compression=zipfile.ZIP_STORED,
        strict_timestamps=True,
    ) as bundle:
        bundle.comment = b""
        for source in ordered_sources:
            relative = source.relative_to(root).as_posix()
            info = zipfile.ZipInfo(f"{archive_root}/{relative}", date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = ZIP_CREATE_SYSTEM
            info.create_version = ZIP_VERSION
            info.extract_version = ZIP_VERSION
            info.flag_bits = 0
            info.internal_attr = 0
            info.extra = b""
            info.comment = b""
            mode = 0o100755 if source.suffix in {".mjs", ".py"} else 0o100644
            info.external_attr = mode << 16
            bundle.writestr(info, source.read_bytes())


def main() -> int:
    subprocess.run([sys.executable, str(ROOT / "scripts/validate.py")], check=True)
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    DIST.mkdir(exist_ok=True)
    archive = DIST / f"flitrealize-{version}.zip"
    write_archive(archive, runtime_files())

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = archive.with_suffix(archive.suffix + ".sha256")
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="ascii", newline="\n")
    print(f"created {archive.relative_to(ROOT)}")
    print(f"sha256 {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
