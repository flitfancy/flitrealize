#!/usr/bin/env python3
"""Extract one version's CHANGELOG body for deterministic release notes."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def extract_version_notes(changelog: str, version: str) -> str:
    heading = re.compile(rf"^## \[{re.escape(version)}\](?:\s+-\s+.*)?\s*$", re.MULTILINE)
    match = heading.search(changelog)
    if not match:
        raise ValueError(f"version {version} is missing from CHANGELOG")
    next_heading = re.search(r"^## \[", changelog[match.end() :], re.MULTILINE)
    end = match.end() + next_heading.start() if next_heading else len(changelog)
    body = changelog[match.end() : end].strip()
    if not body:
        raise ValueError(f"version {version} has empty release notes")
    return body + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", help="Version to extract; defaults to the canonical VERSION file.")
    parser.add_argument("--output", type=Path, help="Write notes to this path instead of stdout.")
    arguments = parser.parse_args()

    version = arguments.version or (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    try:
        notes = extract_version_notes(changelog, version)
    except ValueError as error:
        print(f"[FAIL] release notes: {error}")
        return 1

    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(notes, encoding="utf-8", newline="\n")
        print(f"[PASS] release notes: {version} -> {arguments.output}")
    else:
        print(notes, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
