#!/usr/bin/env python3
"""Check version, documentation, artifact, checksum, license, and tag consistency."""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class Checks:
    def __init__(self) -> None:
        self.failures: list[str] = []

    def check(self, name: str, condition: bool, detail: str) -> None:
        print(f"[{'PASS' if condition else 'FAIL'}] {name}: {detail}")
        if not condition:
            self.failures.append(name)


def git(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *arguments],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--allow-missing-license",
        action="store_true",
        help="Keep repository CI usable before the release owner chooses a license.",
    )
    arguments = parser.parse_args()
    checks = Checks()
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    tag_name = f"v{version}"
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    readme_zh = (ROOT / "README.zh-CN.md").read_text(encoding="utf-8")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")

    marker = "\x60" + tag_name + "\x60"
    checks.check("README version", marker in readme, tag_name)
    checks.check("Chinese README version", marker in readme_zh, tag_name)
    checks.check(
        "CHANGELOG version",
        re.search(rf"^## \[{re.escape(version)}\](?:\s|$)", changelog, re.MULTILINE) is not None,
        version,
    )

    archive = ROOT / "dist" / f"flitrealize-{version}.zip"
    checksum = archive.with_suffix(archive.suffix + ".sha256")
    checks.check("release ZIP", archive.is_file(), archive.name)
    checks.check("checksum sidecar", checksum.is_file(), checksum.name)
    if archive.is_file() and checksum.is_file():
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        expected_line = f"{digest}  {archive.name}"
        actual_line = checksum.read_text(encoding="ascii").strip()
        checks.check("ZIP checksum", actual_line == expected_line, digest)
        with zipfile.ZipFile(archive) as bundle:
            try:
                packaged_version = bundle.read("flitrealize/VERSION").decode("utf-8").strip()
            except KeyError:
                packaged_version = ""
        checks.check(
            "packaged VERSION",
            packaged_version == version,
            packaged_version or "missing from ZIP",
        )

    license_files = [
        path
        for name in ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING")
        if (path := ROOT / name).is_file()
    ]
    if license_files:
        checks.check("license", True, license_files[0].name)
    elif arguments.allow_missing_license:
        print("[WARN] license: missing; strict release DryRun remains blocked")
    else:
        checks.check("license", False, "missing; choose a public reuse license before release")

    tag_query = git("tag", "--list", tag_name)
    if tag_query.returncode != 0:
        checks.check("Git tag query", False, tag_query.stderr.strip() or "git tag failed")
    elif not tag_query.stdout.strip():
        checks.check("Git tag candidate", True, f"{tag_name} is available")
    else:
        tag_commit = git("rev-list", "-n", "1", tag_name)
        head_commit = git("rev-parse", "HEAD")
        consistent = (
            tag_commit.returncode == 0
            and head_commit.returncode == 0
            and tag_commit.stdout.strip() == head_commit.stdout.strip()
        )
        checks.check(
            "Git tag target",
            consistent,
            "points to HEAD" if consistent else f"{tag_name} does not point to HEAD",
        )

    if checks.failures:
        print(f"\nRELEASE CHECK FAILED: {len(checks.failures)} item(s)")
        return 1
    print("\nRELEASE CONSISTENCY PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
