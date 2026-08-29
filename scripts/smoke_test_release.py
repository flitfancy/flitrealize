#!/usr/bin/env python3
"""Extract the current release ZIP and test it without using installed host state."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from package_release import ARCHIVE_ROOT, ROOT, runtime_files


def fail(message: str) -> None:
    raise RuntimeError(message)


def run(
    arguments: list[str],
    *,
    cwd: Path,
    environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        cwd=cwd,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )


def main() -> int:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    archive = ROOT / "dist" / f"flitrealize-{version}.zip"
    if not archive.is_file():
        fail(f"Release archive is missing: {archive}")
    node = shutil.which("node")
    if not node:
        fail("Node.js is required for the release smoke test")

    expected_entries = {
        f"{ARCHIVE_ROOT}/{path.relative_to(ROOT).as_posix()}"
        for path in runtime_files()
    }
    with tempfile.TemporaryDirectory(prefix="flitrealize-smoke-") as temporary:
        temporary_root = Path(temporary)
        with zipfile.ZipFile(archive) as bundle:
            actual_entries = set(bundle.namelist())
            for name in actual_entries:
                parsed = PurePosixPath(name)
                if parsed.is_absolute() or ".." in parsed.parts:
                    fail(f"Unsafe ZIP member: {name}")
            if actual_entries != expected_entries:
                missing = sorted(expected_entries - actual_entries)
                extra = sorted(actual_entries - expected_entries)
                fail(f"ZIP contents differ; missing={missing}, extra={extra}")
            bundle.extractall(temporary_root)

        extracted_root = temporary_root / ARCHIVE_ROOT
        for source in runtime_files():
            relative = source.relative_to(ROOT)
            extracted = extracted_root / relative
            if extracted.read_bytes() != source.read_bytes():
                fail(f"Packaged bytes differ from source: {relative}")

        manifest_path = extracted_root / "scripts/actions/manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        action_root = extracted_root / "scripts/actions"
        missing_action_files: list[str] = []
        for action_name, action in manifest.get("actions", {}).items():
            file_name = action.get("file") if isinstance(action, dict) else None
            if not isinstance(file_name, str):
                fail(f"Packaged manifest action has no file: {action_name}")
            relative_action = PurePosixPath(file_name)
            if relative_action.is_absolute() or ".." in relative_action.parts:
                fail(f"Unsafe packaged action path: {file_name}")
            action_path = action_root / Path(*relative_action.parts)
            if not action_path.is_file():
                missing_action_files.append(file_name)
        if missing_action_files:
            fail(f"Packaged manifest action files are missing: {sorted(missing_action_files)}")

        list_result = run(
            [node, str(extracted_root / "scripts/action-runner.mjs"), "list"],
            cwd=extracted_root,
        )
        if list_result.returncode != 0:
            fail(f"Packaged action registry failed: {list_result.stderr.strip()}")
        listed = json.loads(list_result.stdout)
        listed_providers = listed.get("providers", [])
        listed_actions = listed.get("actions", [])
        if (
            listed.get("schemaVersion") != 2
            or listed.get("skillVersion") != version
            or [provider.get("id") for provider in listed_providers] != ["easyeda-pro"]
            or not listed_actions
            or any(
                action.get("contractVersion") != 1
                or action.get("runtime") not in {"host", "eda"}
                or (
                    action.get("providers") != []
                    if action.get("runtime") == "host"
                    else action.get("providers") != ["easyeda-pro"]
                )
                or not action.get("domain")
                for action in listed_actions
            )
        ):
            fail("Packaged action registry returned an incomplete interface")

        isolated_state = temporary_root / "isolated-host-state"
        environment = os.environ.copy()
        environment["FLITREALIZE_HOME"] = str(isolated_state)
        audit_report = temporary_root / "schematic-contract-audit-report.json"
        audit_fixture = ROOT / "tests/fixtures/schematic-contract/valid-minimal.json"
        host_audit = run(
            [
                node,
                str(extracted_root / "scripts/action-runner.mjs"),
                "run",
                "--action",
                "schematic-contract-audit",
                "--input-file",
                str(audit_fixture),
                "--report-file",
                str(audit_report),
            ],
            cwd=extracted_root,
            environment=environment,
        )
        if host_audit.returncode != 0:
            fail(f"Packaged host Action failed: {host_audit.stderr.strip()}")
        audit_summary = json.loads(host_audit.stdout)
        if (
            audit_summary.get("runtime") != "host"
            or audit_summary.get("provider") is not None
            or audit_summary.get("status") != "passed"
            or audit_summary.get("counts", {}).get("componentCount") != 2
            or not audit_report.is_file()
        ):
            fail(f"Packaged host Action returned an incomplete audit: {audit_summary}")

        missing_adapter = run(
            [
                node,
                str(extracted_root / "scripts/action-runner.mjs"),
                "run",
                "--action",
                "eda-capabilities",
            ],
            cwd=extracted_root,
            environment=environment,
        )
        if missing_adapter.returncode == 0:
            fail("Packaged runner unexpectedly succeeded without a registered adapter")
        error_line = missing_adapter.stderr.strip().splitlines()[-1]
        error_payload = json.loads(error_line)
        if error_payload.get("error", {}).get("code") != "EDA_HOST_ERROR":
            fail(f"Unexpected missing-adapter failure: {error_payload}")
        report_file = error_payload.get("reportFile")
        if not report_file or not Path(report_file).is_file():
            fail("Failed action did not retain a host-local evidence report")

    print(f"[PASS] clean ZIP smoke: {archive.name}")
    print(f"[PASS] runtime entries: {len(expected_entries)} exact files")
    print("[PASS] packaged host schematic contract audit is deterministic and provider-free")
    print("[PASS] isolated missing-adapter failure is clear and evidence-backed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
