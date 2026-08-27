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


def runtime_files() -> list[Path]:
    return [
        ROOT / "LICENSE",
        ROOT / "VERSION",
        ROOT / "SKILL.md",
        ROOT / "agents/openai.yaml",
        ROOT / "scripts/action-runner.mjs",
        ROOT / "scripts/eda-host.mjs",
        ROOT / "scripts/actions/manifest.json",
        *sorted((ROOT / "scripts/actions").glob("*.js")),
        *sorted((ROOT / "references").glob("*.md")),
    ]


def main() -> int:
    subprocess.run([sys.executable, str(ROOT / "scripts/validate.py")], check=True)
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    DIST.mkdir(exist_ok=True)
    archive = DIST / f"flitrealize-{version}.zip"

    with zipfile.ZipFile(archive, "w") as bundle:
        for source in runtime_files():
            relative = source.relative_to(ROOT).as_posix()
            info = zipfile.ZipInfo(f"{ARCHIVE_ROOT}/{relative}", date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            mode = 0o100755 if source.suffix in {".mjs", ".py"} else 0o100644
            info.external_attr = mode << 16
            bundle.writestr(info, source.read_bytes(), compresslevel=9)

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = archive.with_suffix(archive.suffix + ".sha256")
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="ascii", newline="\n")
    print(f"created {archive.relative_to(ROOT)}")
    print(f"sha256 {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
