#!/usr/bin/env python3
"""Scan added Git lines for likely credentials and private host/project data."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
PRIVATE_NAMES = {
    "battle_log.md",
    "catalog.csv",
    "current_handoff.md",
    "host.json",
    "user.md",
}
RULES = [
    ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")),
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    (
        "credential-assignment",
        re.compile(
            r"(?i)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b"
            r"\s*[:=]\s*['\"]?[A-Za-z0-9_./+=:@-]{16,}"
        ),
    ),
    ("credential-url", re.compile(r"https?://[^/\s:@]+:[^/\s@]+@")),
    ("windows-user-path", re.compile(r"(?i)\b[A-Z]:[\\/]Users[\\/][^\\/\s]+")),
    ("unix-user-path", re.compile(r"(?:^|[\s\"'])/(?:Users|home)/[^/\s]+")),
]


def git(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *arguments],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )


def added_lines(diff: str) -> list[tuple[str, int, str]]:
    current_file = "unknown"
    new_line = 0
    added: list[tuple[str, int, str]] = []
    hunk = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            current_file = line[6:]
            continue
        match = hunk.match(line)
        if match:
            new_line = int(match.group(1))
            continue
        if line.startswith("+") and not line.startswith("+++"):
            added.append((current_file, new_line, line[1:]))
            new_line += 1
        elif line.startswith("-") and not line.startswith("---"):
            continue
        elif line and not line.startswith("\\"):
            new_line += 1
    return added


def staged_added_lines(diff: str) -> list[tuple[str, int, str]]:
    """Backward-compatible name retained for callers and tests."""
    return added_lines(diff)


def normalize_base_revision(revision: str) -> str:
    """Map GitHub's all-zero first-push sentinel to Git's empty tree."""
    value = revision.strip()
    if value and set(value) == {"0"}:
        return EMPTY_TREE
    return value


def scan_inputs(revision_range: list[str] | None) -> tuple[str, subprocess.CompletedProcess[str], subprocess.CompletedProcess[str]]:
    if revision_range:
        base, head = revision_range
        base = normalize_base_revision(base)
        if not base or not head or base.startswith("-") or head.startswith("-"):
            raise ValueError("revision range must contain two non-option Git revisions")
        label = f"committed-range {base}..{head}"
        names = git("diff", "--name-only", "--diff-filter=ACMR", base, head, "--")
        diff = git("diff", "--unified=0", "--no-color", base, head, "--")
        return label, names, diff

    return (
        "staged",
        git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "--"),
        git("diff", "--cached", "--unified=0", "--no-color", "--"),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--range",
        nargs=2,
        metavar=("BASE", "HEAD"),
        dest="revision_range",
        help="Scan lines added between two Git revisions; all-zero BASE means the empty tree.",
    )
    arguments = parser.parse_args()

    try:
        label, names_result, diff_result = scan_inputs(arguments.revision_range)
    except ValueError as error:
        print(f"[FAIL] secret scan: {error}")
        return 1
    if names_result.returncode != 0 or diff_result.returncode != 0:
        print(f"[FAIL] {label} secret scan: git diff failed")
        return 1

    findings: set[tuple[str, int, str]] = set()
    for raw_path in names_result.stdout.splitlines():
        path = Path(raw_path)
        lower_name = path.name.lower()
        if lower_name in PRIVATE_NAMES:
            findings.add((raw_path, 0, "private-file"))
        if lower_name == ".env" or (
            lower_name.startswith(".env.")
            and not lower_name.endswith((".example", ".sample", ".template"))
        ):
            findings.add((raw_path, 0, "environment-file"))

    for path, line_number, text in added_lines(diff_result.stdout):
        for rule_name, pattern in RULES:
            if pattern.search(text):
                findings.add((path, line_number, rule_name))

    if findings:
        print(f"[FAIL] {label} secret scan: {len(findings)} possible issue(s)")
        for path, line_number, rule_name in sorted(findings):
            location = f"{path}:{line_number}" if line_number else path
            print(f"- {location} [{rule_name}]")
        print("Matched content is intentionally not printed.")
        return 1

    file_count = len([line for line in names_result.stdout.splitlines() if line])
    print(f"[PASS] {label} secret scan: {file_count} file(s), no matched patterns")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
