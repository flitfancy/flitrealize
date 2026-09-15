#!/usr/bin/env python3
"""Validate the portable FlitRealize skill repository."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {".js", ".json", ".md", ".mjs", ".py", ".ps1", ".txt", ".yaml", ".yml"}
IGNORED_PARTS = {".git", ".flitrealize", "dist", "__pycache__", "node_modules"}


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


def reachable_reference_files(entrypoint: Path) -> set[Path]:
    """Return source references reachable through local Markdown links."""
    references_root = (ROOT / "references").resolve()
    pattern = re.compile(r"\]\(([^)]+)\)")
    reachable: set[Path] = set()
    visited: set[Path] = set()
    pending = [entrypoint.resolve()]

    while pending:
        path = pending.pop()
        if path in visited or not path.is_file() or path.suffix.lower() != ".md":
            continue
        visited.add(path)
        text = path.read_text(encoding="utf-8")
        for raw_target in pattern.findall(text):
            target = raw_target.strip().split(maxsplit=1)[0].strip("<>")
            if not target or target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            target = unquote(target.split("#", 1)[0])
            resolved = (path.parent / target).resolve()
            try:
                resolved.relative_to(references_root)
            except ValueError:
                continue
            if resolved.is_file() and resolved.suffix.lower() == ".md" and resolved not in reachable:
                reachable.add(resolved)
                pending.append(resolved)

    return reachable


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


def runtime_document_files(root: Path = ROOT) -> list[Path]:
    return [
        root / "SKILL.md",
        *sorted((root / "references").rglob("*.md")),
        *sorted((root / "development").rglob("*.md")),
    ]


def runtime_document_failures(root: Path = ROOT) -> list[str]:
    """Reject obsolete mirror authority and links back into non-runtime copies."""
    failures: list[str] = []
    inactive_roots = [(root / "docs/zh-CN").resolve(), (root / "docs/en-backup").resolve()]
    for path in runtime_document_files(root):
        if not path.is_file():
            failures.append(f"missing {path.relative_to(root)}")
            continue
        text = path.read_text(encoding="utf-8")
        if "英文源文件 SHA-256" in text or "中文只读镜像" in text:
            failures.append(f"obsolete mirror declaration: {path.relative_to(root)}")
        for target in re.findall(r"\]\(([^)]+)\)", text):
            target = target.strip().split(maxsplit=1)[0].strip("<>")
            if target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            resolved = (path.parent / unquote(target.split("#", 1)[0])).resolve()
            if any(resolved.is_relative_to(inactive) for inactive in inactive_roots):
                failures.append(f"runtime link enters inactive copy: {path.relative_to(root)} -> {target}")
    return failures


def english_backup_failures(root: Path = ROOT) -> list[str]:
    """Validate a fixed historical snapshot, not translation parity with live Chinese."""
    backup_root = (root / "docs/en-backup").resolve()
    failures: list[str] = []
    try:
        manifest = json.loads((backup_root / "manifest.json").read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or (
            manifest.get("schemaVersion") != 1
            or manifest.get("runtimeLanguage") != "zh-CN"
            or manifest.get("snapshotLanguage") != "en"
            or manifest.get("mode") != "historical-reference-only"
            or not isinstance(manifest.get("files"), list)
            or not manifest["files"]
        ):
            return ["invalid English snapshot manifest"]
        listed: set[str] = set()
        sources: set[str] = set()
        for entry in manifest["files"]:
            if not isinstance(entry, dict):
                failures.append("invalid snapshot entry")
                continue
            source, name, expected = entry.get("source"), entry.get("backup"), entry.get("sha256")
            if (
                not isinstance(source, str) or not source
                or not isinstance(name, str) or not name.endswith(".bak")
                or not isinstance(expected, str) or not re.fullmatch(r"[0-9A-F]{64}", expected)
            ):
                failures.append("invalid snapshot path or digest")
                continue
            if any("\\" in value or ":" in value or Path(value).is_absolute() or ".." in Path(value).parts for value in (source, name)):
                failures.append(f"unsafe snapshot path: {name}")
                continue
            path = (backup_root / name).resolve()
            if not path.is_relative_to(backup_root) or name in listed or source in sources:
                failures.append(f"unsafe or duplicate snapshot entry: {name}")
                continue
            listed.add(name)
            sources.add(source)
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest().upper() != expected:
                failures.append(f"missing or changed English backup: {name}")
        actual = {path.relative_to(backup_root).as_posix() for path in backup_root.rglob("*.bak") if path.is_file()}
        if actual != listed:
            failures.append("English backup inventory differs from manifest")
    except (OSError, ValueError) as error:
        failures.append(f"English backup unreadable: {error}")
    return failures


def action_registry_failures(root: Path = ROOT) -> list[str]:
    """Reuse runner contract validation; independently check the packaged Action inventory."""
    failures: list[str] = []
    try:
        registry_check = subprocess.run(
            ["node", str(root / "scripts/action-runner.mjs"), "list", "--full"],
            cwd=root, capture_output=True, text=True, encoding="utf-8", check=False,
        )
        if registry_check.returncode:
            raise ValueError(registry_check.stderr.strip() or "Action registry validation failed")
        registry = json.loads(registry_check.stdout)
        registered = {action["file"] for action in registry["actions"]}
        action_root = root / "scripts/actions"
        actual = {path.relative_to(action_root).as_posix() for path in action_root.rglob("*.js")}
        if actual - registered:
            failures.append("unregistered: " + ", ".join(sorted(actual - registered)))
        if registered - actual:
            failures.append("missing files: " + ", ".join(sorted(registered - actual)))
    except (OSError, ValueError) as error:
        failures.append(str(error))
    return failures


def main() -> int:
    checks = Checks()
    required = [
        ROOT / "LICENSE",
        ROOT / "package.json",
        ROOT / "SKILL.md",
        ROOT / "agents/openai.yaml",
        ROOT / ".github/workflows/release.yml",
        ROOT / ".github/workflows/validate.yml",
        ROOT / "scripts/action-runner.mjs",
        ROOT / "scripts/check_release.py",
        ROOT / "scripts/eda-host.mjs",
        ROOT / "scripts/extract_release_notes.py",
        ROOT / "scripts/release.ps1",
        ROOT / "scripts/run-tests.mjs",
        ROOT / "scripts/scan_staged_secrets.py",
        ROOT / "scripts/smoke_test_release.py",
        ROOT / "scripts/actions/manifest.json",
        ROOT / "schemas/schematic-contract.v1.schema.json",
        ROOT / "schemas/schematic-placement-plan.v1.schema.json",
        ROOT / "schemas/schematic-snapshot.v1.schema.json",
    ]
    missing = [str(path.relative_to(ROOT)) for path in required if not path.is_file()]
    checks.check("required files", not missing, "present" if not missing else ", ".join(missing))

    skill_path = ROOT / "SKILL.md"
    frontmatter = parse_frontmatter(skill_path) if skill_path.is_file() else {}
    checks.check("skill name", frontmatter.get("name") == "flitrealize", frontmatter.get("name", "missing"))
    description = frontmatter.get("description", "")
    checks.check(
        "skill description",
        0 < len(description) <= 1024,
        "nonempty description within 1024 characters; scope is reviewed separately",
    )

    openai_path = ROOT / "agents/openai.yaml"
    openai_yaml = openai_path.read_text(encoding="utf-8") if openai_path.is_file() else ""
    checks.check(
        "OpenAI metadata",
        'display_name: "FlitRealize"' in openai_yaml and "$flitrealize" in openai_yaml,
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

    runtime_failures = runtime_document_failures()
    checks.check(
        "runtime document authority",
        not runtime_failures,
        "canonical documents do not route into mirrors or backups" if not runtime_failures else "; ".join(runtime_failures),
    )
    backup_failures = english_backup_failures()
    checks.check(
        "English historical backup",
        not backup_failures,
        "snapshot hashes match; Chinese edits do not require English synchronization" if not backup_failures else "; ".join(backup_failures),
    )

    reachable_references = reachable_reference_files(ROOT / "SKILL.md")
    undiscoverable = []
    for source in sorted((ROOT / "references").rglob("*.md")):
        if source.resolve() not in reachable_references:
            undiscoverable.append(source.relative_to(ROOT / "references").as_posix())
    checks.check(
        "reference routing",
        not undiscoverable,
        "all references reachable from SKILL.md" if not undiscoverable else ", ".join(undiscoverable),
    )

    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip() if (ROOT / "VERSION").is_file() else ""
    checks.check(
        "version",
        bool(re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version)),
        version or "missing",
    )

    package_failures: list[str] = []
    try:
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        if package.get("name") != "flitrealize":
            package_failures.append("name")
        if package.get("private") is not True:
            package_failures.append("private")
        if package.get("engines", {}).get("node") != ">=22":
            package_failures.append("engines.node")
        if package.get("scripts", {}).get("test") != "node scripts/run-tests.mjs":
            package_failures.append("scripts.test")
        if "version" in package:
            package_failures.append("version must remain canonical in VERSION only")
    except (OSError, json.JSONDecodeError) as error:
        package_failures.append(str(error))
    checks.check(
        "Node contract",
        not package_failures,
        "Node >=22 with one test entrypoint" if not package_failures else "; ".join(package_failures),
    )

    registry_failures = action_registry_failures()
    checks.check(
        "action registry",
        not registry_failures,
        "all actions and modes registered" if not registry_failures else "; ".join(registry_failures),
    )

    schema_failures: list[str] = []
    expected_schemas = {
        "schematic-contract.v1.schema.json": "flitrealize.schematic-contract",
        "schematic-placement-plan.v1.schema.json": "flitrealize.schematic-placement-plan",
        "schematic-snapshot.v1.schema.json": "flitrealize.schematic-snapshot",
    }
    for file_name, expected_kind in expected_schemas.items():
        path = ROOT / "schemas" / file_name
        try:
            schema = json.loads(path.read_text(encoding="utf-8"))
            if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
                schema_failures.append(f"{file_name}: draft")
            if schema.get("properties", {}).get("kind", {}).get("const") != expected_kind:
                schema_failures.append(f"{file_name}: kind")
            if schema.get("properties", {}).get("schemaVersion", {}).get("const") != 1:
                schema_failures.append(f"{file_name}: version")
            if schema.get("additionalProperties") is not False:
                schema_failures.append(f"{file_name}: root must be closed")
        except (OSError, json.JSONDecodeError) as error:
            schema_failures.append(f"{file_name}: {error}")
    checks.check(
        "schematic schemas",
        not schema_failures,
        "Contract, PlacementPlan, and Snapshot v1 are machine-readable" if not schema_failures else "; ".join(schema_failures),
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
