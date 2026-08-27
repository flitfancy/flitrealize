#!/usr/bin/env python3
"""Validate the portable FlitRealize skill repository."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {".js", ".json", ".md", ".mjs", ".py", ".ps1", ".txt", ".yaml", ".yml"}
IGNORED_PARTS = {".git", "dist", "__pycache__"}


class Checks:
    def __init__(self) -> None:
        self.failures: list[str] = []

    def check(self, name: str, condition: bool, detail: str) -> None:
        label = "PASS" if condition else "FAIL"
        print(f"[{label}] {name}: {detail}")
        if not condition:
            self.failures.append(f"{name}: {detail}")


def public_text_files() -> list[Path]:
    return sorted(
        path
        for path in ROOT.rglob("*")
        if path.is_file()
        and path.suffix.lower() in TEXT_SUFFIXES
        and not any(part in IGNORED_PARTS for part in path.parts)
    )


def markdown_link_failures(files: list[Path]) -> list[str]:
    failures: list[str] = []
    pattern = re.compile(r"\]\(([^)]+)\)")
    for path in files:
        if path.suffix.lower() != ".md":
            continue
        text = path.read_text(encoding="utf-8")
        for raw_target in pattern.findall(text):
            target = raw_target.strip().split(maxsplit=1)[0].strip("<>")
            if not target or target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            target = unquote(target.split("#", 1)[0])
            resolved = (path.parent / target).resolve()
            if not resolved.exists():
                failures.append(f"{path.relative_to(ROOT)} -> {target}")
    return failures


def parse_frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"\A---\n(.*?)\n---(?:\n|\Z)", text, re.DOTALL)
    if not match:
        return {}
    values: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        values[key.strip()] = value.strip().strip('"')
    return values


def translation_pairs() -> list[tuple[Path, Path]]:
    pairs = [(ROOT / "SKILL.md", ROOT / "docs/zh-CN/SKILL.zh-CN.md")]
    for source in sorted((ROOT / "references").glob("*.md")):
        pairs.append((source, ROOT / "docs/zh-CN/references" / source.name))
    return pairs


def main() -> int:
    checks = Checks()
    required = [
        ROOT / "LICENSE",
        ROOT / "SKILL.md",
        ROOT / "agents/openai.yaml",
        ROOT / "scripts/action-runner.mjs",
        ROOT / "scripts/check_release.py",
        ROOT / "scripts/eda-host.mjs",
        ROOT / "scripts/release.ps1",
        ROOT / "scripts/run-tests.mjs",
        ROOT / "scripts/scan_staged_secrets.py",
        ROOT / "scripts/smoke_test_release.py",
        ROOT / "scripts/actions/manifest.json",
        ROOT / "scripts/actions/eda-capabilities.js",
        ROOT / "scripts/actions/pcb-grounding-inspect.js",
        ROOT / "scripts/actions/pcb-ground-stitching.js",
        ROOT / "scripts/actions/pcb-ground-vias.js",
        ROOT / "scripts/actions/pcb-layer-stack.js",
    ]
    missing = [str(path.relative_to(ROOT)) for path in required if not path.is_file()]
    checks.check("required files", not missing, "present" if not missing else ", ".join(missing))

    frontmatter = parse_frontmatter(ROOT / "SKILL.md") if not missing else {}
    checks.check("skill name", frontmatter.get("name") == "flitrealize", frontmatter.get("name", "missing"))
    description = frontmatter.get("description", "")
    checks.check(
        "skill description",
        "electronics hardware" in description and "software-only" in description,
        "hardware scope and software boundary are explicit",
    )

    openai_yaml = (ROOT / "agents/openai.yaml").read_text(encoding="utf-8") if not missing else ""
    checks.check(
        "OpenAI metadata",
        'display_name: "FlitRealize T1"' in openai_yaml and "$flitrealize" in openai_yaml,
        "display name and invocation match",
    )

    files = public_text_files()
    link_failures = markdown_link_failures(files)
    checks.check(
        "Markdown links",
        not link_failures,
        "all local targets exist" if not link_failures else "; ".join(link_failures),
    )

    windows_absolute = re.compile(r"(?<![A-Za-z0-9+.-])[A-Za-z]" + ":" + r"[\\/]")
    old_brand = "skywork" + "-e"
    portability_failures: list[str] = []
    for path in files:
        text = path.read_text(encoding="utf-8")
        if windows_absolute.search(text):
            portability_failures.append(f"absolute path in {path.relative_to(ROOT)}")
        if old_brand.lower() in text.lower():
            portability_failures.append(f"old skill name in {path.relative_to(ROOT)}")
    checks.check(
        "portable public text",
        not portability_failures,
        "no author path or old skill name" if not portability_failures else "; ".join(portability_failures),
    )

    private_names = {"USER.md", "catalog.csv", "CURRENT_HANDOFF.md", "BATTLE_LOG.md"}
    private_files = [
        str(path.relative_to(ROOT))
        for path in ROOT.rglob("*")
        if path.is_file()
        and path.name in private_names
        and not any(part in IGNORED_PARTS for part in path.parts)
    ]
    checks.check(
        "private artifacts",
        not private_files,
        "none bundled" if not private_files else ", ".join(private_files),
    )

    hash_failures: list[str] = []
    hash_pattern = re.compile(r"英文源文件 SHA-256：`([0-9A-F]{64})`")
    pairs = translation_pairs()
    for source, translation in pairs:
        if not translation.is_file():
            hash_failures.append(f"missing {translation.relative_to(ROOT)}")
            continue
        marker = hash_pattern.search(translation.read_text(encoding="utf-8"))
        actual = hashlib.sha256(source.read_bytes()).hexdigest().upper()
        if not marker or marker.group(1) != actual:
            hash_failures.append(str(translation.relative_to(ROOT)))
    checks.check(
        "Chinese source hashes",
        not hash_failures,
        f"{len(pairs)}/{len(pairs)} match" if not hash_failures else "stale: " + ", ".join(hash_failures),
    )

    reference_links = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    undiscoverable = [
        source.name
        for source in sorted((ROOT / "references").glob("*.md"))
        if f"references/{source.name}" not in reference_links
    ]
    checks.check(
        "reference routing",
        not undiscoverable,
        "all references linked from SKILL.md" if not undiscoverable else ", ".join(undiscoverable),
    )

    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip() if (ROOT / "VERSION").is_file() else ""
    checks.check(
        "version",
        bool(re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version)),
        version or "missing",
    )

    action_registry_failures: list[str] = []
    try:
        manifest = json.loads((ROOT / "scripts/actions/manifest.json").read_text(encoding="utf-8"))
        actions = manifest.get("actions", {})
        if manifest.get("schemaVersion") != 1 or not isinstance(actions, dict):
            action_registry_failures.append("manifest schema/actions")
            actions = {}
        registered_files: set[str] = set()
        for action_name, action in actions.items():
            if not isinstance(action, dict):
                action_registry_failures.append(f"{action_name}: invalid record")
                continue
            file_name = action.get("file")
            modes = action.get("modes")
            default_mode = action.get("defaultMode")
            if not isinstance(file_name, str):
                action_registry_failures.append(f"{action_name}: missing file")
            else:
                registered_files.add(file_name)
            if not isinstance(action.get("description"), str) or not action["description"].strip():
                action_registry_failures.append(f"{action_name}: missing description")
            if not isinstance(modes, dict) or default_mode not in modes:
                action_registry_failures.append(f"{action_name}: invalid default mode")
                continue
            for mode_name, contract in modes.items():
                if not isinstance(contract, dict) or not isinstance(contract.get("mutates"), bool):
                    action_registry_failures.append(f"{action_name}/{mode_name}: mutates must be boolean")
        actual_files = {path.name for path in (ROOT / "scripts/actions").glob("*.js")}
        if registered_files != actual_files:
            missing_registry = sorted(actual_files - registered_files)
            missing_files = sorted(registered_files - actual_files)
            if missing_registry:
                action_registry_failures.append("unregistered: " + ", ".join(missing_registry))
            if missing_files:
                action_registry_failures.append("missing files: " + ", ".join(missing_files))
    except (OSError, json.JSONDecodeError) as error:
        action_registry_failures.append(str(error))
    checks.check(
        "action registry",
        not action_registry_failures,
        "all actions and modes registered" if not action_registry_failures else "; ".join(action_registry_failures),
    )

    if checks.failures:
        print(f"\nFAILED: {len(checks.failures)} check(s)")
        for failure in checks.failures:
            print(f"- {failure}")
        return 1
    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
