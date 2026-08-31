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


def translation_pairs() -> list[tuple[Path, Path]]:
    pairs = [(ROOT / "SKILL.md", ROOT / "docs/zh-CN/SKILL.zh-CN.md")]
    for source in sorted((ROOT / "references").rglob("*.md")):
        relative = source.relative_to(ROOT / "references")
        pairs.append((source, ROOT / "docs/zh-CN/references" / relative))
    return pairs


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
        "electronics hardware" in description and "software-only" in description,
        "hardware scope and software boundary are explicit",
    )

    openai_path = ROOT / "agents/openai.yaml"
    openai_yaml = openai_path.read_text(encoding="utf-8") if openai_path.is_file() else ""
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

    action_registry_failures: list[str] = []
    try:
        manifest = json.loads((ROOT / "scripts/actions/manifest.json").read_text(encoding="utf-8"))
        providers = manifest.get("providers", {})
        actions = manifest.get("actions", {})
        workflows = manifest.get("workflows", {})
        if (
            manifest.get("schemaVersion") != 2
            or not isinstance(providers, dict)
            or not isinstance(actions, dict)
            or not actions
            or not isinstance(workflows, dict)
        ):
            action_registry_failures.append("manifest schema/providers/actions/workflows")
            providers = {}
            actions = {}
            workflows = {}
        for provider_name, provider in providers.items():
            if (
                not isinstance(provider_name, str)
                or not provider_name
                or not isinstance(provider, dict)
                or provider.get("kind") != "eda"
                or not isinstance(provider.get("displayName"), str)
            ):
                action_registry_failures.append(f"{provider_name}: invalid provider")
        registered_files: set[str] = set()
        for action_name, action in actions.items():
            if not isinstance(action, dict):
                action_registry_failures.append(f"{action_name}: invalid record")
                continue
            file_name = action.get("file")
            modes = action.get("modes")
            default_mode = action.get("defaultMode")
            runtime = action.get("runtime")
            action_providers = action.get("providers")
            if not isinstance(file_name, str):
                action_registry_failures.append(f"{action_name}: missing file")
            else:
                registered_files.add(file_name)
            if not isinstance(action.get("description"), str) or not action["description"].strip():
                action_registry_failures.append(f"{action_name}: missing description")
            if not isinstance(action.get("contractVersion"), int) or action["contractVersion"] < 1:
                action_registry_failures.append(f"{action_name}: invalid contractVersion")
            if not isinstance(action.get("domain"), str) or not action["domain"].strip():
                action_registry_failures.append(f"{action_name}: invalid domain")
            if "internal" in action and not isinstance(action["internal"], bool):
                action_registry_failures.append(f"{action_name}: internal must be boolean")
            if runtime not in {"host", "eda"} or not isinstance(action_providers, list):
                action_registry_failures.append(f"{action_name}: invalid runtime/providers")
            elif runtime == "host" and action_providers:
                action_registry_failures.append(f"{action_name}: host action declares providers")
            elif runtime == "eda" and (
                not action_providers
                or any(provider not in providers for provider in action_providers)
            ):
                action_registry_failures.append(f"{action_name}: unknown or missing provider")
            if not isinstance(modes, dict) or default_mode not in modes:
                action_registry_failures.append(f"{action_name}: invalid default mode")
                continue
            for mode_name, contract in modes.items():
                if not isinstance(contract, dict) or not isinstance(contract.get("mutates"), bool):
                    action_registry_failures.append(f"{action_name}/{mode_name}: mutates must be boolean")
        for workflow_name, workflow in workflows.items():
            if not isinstance(workflow, dict):
                action_registry_failures.append(f"{workflow_name}: invalid workflow")
                continue
            provider = workflow.get("provider")
            domain = workflow.get("domain")
            phases = workflow.get("phases")
            if provider not in providers or not isinstance(domain, str) or not isinstance(phases, dict) or not phases:
                action_registry_failures.append(f"{workflow_name}: invalid provider/domain/phases")
                continue
            for phase_name, steps in phases.items():
                if not isinstance(steps, list) or not steps:
                    action_registry_failures.append(f"{workflow_name}/{phase_name}: invalid steps")
                    continue
                for index, step in enumerate(steps):
                    action = actions.get(step.get("action")) if isinstance(step, dict) else None
                    mode = step.get("mode") if isinstance(step, dict) else None
                    if (
                        not isinstance(step, dict)
                        or not isinstance(action, dict)
                        or mode not in action.get("modes", {})
                        or action.get("domain") != domain
                        or (action.get("runtime") == "eda" and provider not in action.get("providers", []))
                        or ("optional" in step and not isinstance(step["optional"], bool))
                    ):
                        action_registry_failures.append(f"{workflow_name}/{phase_name}[{index}]: invalid action reference")
        actual_files = set()
        for path in (ROOT / "scripts/actions").rglob("*.js"):
            rel = path.relative_to(ROOT / "scripts/actions").as_posix()
            actual_files.add(rel)
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
