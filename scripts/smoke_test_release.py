#!/usr/bin/env python3
"""Extract the current release ZIP and test it without using installed host state."""

from __future__ import annotations

import hashlib
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
        encoding="utf-8",
        capture_output=True,
        check=False,
    )


def main(archive: Path | None = None) -> int:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    archive = archive or ROOT / "dist" / f"flitrealize-{version}.zip"
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
        # Windows TEMP can contain an 8.3 alias. Import the extracted modules
        # through the same canonical root used by their containment checks.
        temporary_root = Path(temporary).resolve()
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
        listed_groups = listed.get("actionGroups", {})
        listed_workflows = listed.get("workflows", [])
        listed_workflow_groups = listed.get("workflowGroups", {})
        if (
            listed.get("schemaVersion") != 2
            or listed.get("skillVersion") != version
            or [provider.get("id") for provider in listed_providers] != ["easyeda-pro"]
            or not listed_actions
            or set(listed_groups) != {"pcb", "schematic", "system"}
            or sorted(name for names in listed_groups.values() for name in names)
            != sorted(action.get("name") for action in listed_actions)
            or sorted(workflow.get("name") for workflow in listed_workflows)
            != sorted(manifest.get("workflows", {}))
            or listed_workflow_groups.get("schematic")
            != [name for name, workflow in manifest.get("workflows", {}).items() if workflow.get("domain") == "schematic"]
            or any(
                not isinstance(action.get("contractVersion"), int)
                or action.get("contractVersion") < 1
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
        for domain, purpose, expected_action in [
            ("schematic", "原理图重排", "schematic-reflow"),
            ("pcb", "配色", "pcb-net-color"),
            ("pcb", "布局优化", "pcb-placement"),
            ("pcb", "走线优先级", "pcb-routing-plan"),
            ("pcb", "自动阻抗求解", None),
        ]:
            discovery = run(
                [node, str(extracted_root / "scripts/action-runner.mjs"), "list",
                 "--domain", domain, "--query", purpose],
                cwd=extracted_root, environment=environment,
            )
            if discovery.returncode != 0:
                fail(f"Packaged discovery failed: {discovery.stderr.strip()}")
            found = json.loads(discovery.stdout)
            expected_status = "matched" if expected_action else "no-match"
            if found.get("queryStatus") != expected_status or found.get("readOnly") is not True:
                fail(f"Packaged discovery returned an incorrect result: {found}")
            if expected_status == "matched":
                action = next((a for a in found["actions"] if a["name"] == expected_action), None)
                expected_entry = ("scripts/schematic-reflow.mjs" if expected_action == "schematic-reflow"
                                  else "scripts/pcb-edit.mjs" if expected_action in {"pcb-placement", "pcb-trace-width", "pcb-net-color"}
                                  else "scripts/action-runner.mjs")
                if not action or action.get("entrypoint", {}).get("file") != expected_entry:
                    fail(f"Packaged discovery did not expose its real entrypoint: {expected_action}")
        if isolated_state.exists():
            fail("Read-only discovery unexpectedly initialized host state")

        handoff_project = temporary_root / "handoff-project"
        handoff_project.mkdir()
        handoff_source = handoff_project / "source.json"
        handoff_source.write_text('{"revision":1}', encoding="utf-8")
        checkpoint = {
            "schemaVersion": 1, "updatedAt": "2026-09-11T12:00:00Z",
            "projectRoot": str(handoff_project), "stage": "schematic", "objective": "核对当前输入",
            "target": None, "entrypoint": None, "nextAction": "确认实际原理图目标",
            "openItems": ["尚未连接 EDA"],
            "artifacts": [{"id": "source", "path": "source.json", "sha256": hashlib.sha256(handoff_source.read_bytes()).hexdigest()}],
            "checks": [{"id": "save", "status": "unknown", "scope": "保存状态", "checkedAt": None,
                        "inputs": ["source"], "evidence": [], "limitations": []}],
        }
        handoff_file = handoff_project / "CURRENT_HANDOFF.md"
        handoff_file.write_text("# 续接检查\n\n```flitrealize-handoff\n" + json.dumps(checkpoint, ensure_ascii=False) + "\n```\n", encoding="utf-8")
        handoff_bytes = handoff_file.read_bytes()
        checker_args = [node, str(extracted_root / "scripts/handoff-check.mjs"), "inspect", "--project-root", str(handoff_project)]
        for changed in (False, True):
            if changed:
                handoff_source.write_text('{"revision":2}', encoding="utf-8")
            checked = run(checker_args, cwd=extracted_root, environment=environment)
            if checked.returncode != (1 if changed else 0):
                fail(f"Packaged handoff checker returned unexpected exit: {checked.stderr}")
            payload = json.loads(checked.stdout)
            if (payload.get("recordStatus") != ("needs-reconciliation" if changed else "consistent")
                    or payload.get("liveEdaChecked") is not False or payload.get("readOnly") is not True
                    or payload.get("checks", [{}])[0].get("recordedStatus") != "unknown"):
                fail(f"Packaged handoff checker returned incorrect state: {payload}")
        if isolated_state.exists() or handoff_file.read_bytes() != handoff_bytes:
            fail("Handoff checking changed host or project state")

        view_state_cli = run(
            [node, str(extracted_root / "view-state/cli.mjs"), "--project-root", str(handoff_project)],
            cwd=extracted_root, environment=environment,
        )
        if view_state_cli.returncode != 0 or json.loads(view_state_cli.stdout).get("documentExists") is not True:
            fail(f"Packaged View State CLI failed: {view_state_cli.stderr}")
        view_state_environment = {
            **environment, "FLITREALIZE_TEST_VIEW_STATE_ROOT": str(extracted_root / "view-state"),
        }
        view_state_http = run(
            [node, "--test", str(ROOT / "view-state/tests/view-state-http.test.mjs")],
            cwd=extracted_root, environment=view_state_environment,
        )
        if view_state_http.returncode != 0 or isolated_state.exists() or handoff_file.read_bytes() != handoff_bytes:
            fail(f"Packaged View State HTTP/read-only checks failed: {view_state_http.stdout}\n{view_state_http.stderr}")

        batch_help = run([node, str(extracted_root / "scripts/schematic-components.mjs"), "--help"], cwd=extracted_root, environment=environment)
        if batch_help.returncode != 0 or "--resume" not in batch_help.stdout or isolated_state.exists():
            fail("Packaged batch help failed or initialized an EDA host")
        batch_smoke = run([node, str(ROOT / "tests/helpers/component-batch-package-smoke.mjs"), str(extracted_root)], cwd=extracted_root, environment=environment)
        if batch_smoke.returncode != 0 or isolated_state.exists():
            fail(f"Packaged isolated batch workflow failed: {batch_smoke.stdout}\n{batch_smoke.stderr}")

        pcb_smoke = run([node, str(ROOT / "tests/helpers/pcb-tools-package-smoke.mjs"), str(extracted_root)], cwd=extracted_root, environment=environment)
        if pcb_smoke.returncode != 0 or isolated_state.exists():
            fail(f"Packaged isolated PCB tools failed: {pcb_smoke.stdout}\n{pcb_smoke.stderr}")

        pcb_help = run([node, str(extracted_root / "scripts/pcb-edit.mjs"), "--help"], cwd=extracted_root, environment=environment)
        if pcb_help.returncode != 0 or "--resume-save" not in pcb_help.stdout or isolated_state.exists():
            fail("Packaged PCB wrapper help failed or initialized an EDA host")
        pcb_edit_smoke = run([node, str(ROOT / "tests/helpers/pcb-edit-package-smoke.mjs"), str(extracted_root)], cwd=extracted_root, environment=environment)
        if pcb_edit_smoke.returncode != 0 or isolated_state.exists():
            fail(f"Packaged isolated PCB wrapper failed: {pcb_edit_smoke.stdout}\n{pcb_edit_smoke.stderr}")

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
    print("[PASS] packaged purpose discovery and domain isolation without host initialization")
    print("[PASS] packaged handoff integrity, stale input and unknown save state without mutations")
    print("[PASS] packaged View State CLI, HTTP, reader assets and read-only boundaries")
    print("[PASS] packaged batch placement and partial-failure resume with isolated EDA mock")
    print("[PASS] packaged PCB layout, width, color and priority tools with isolated EDA mock")
    print("[PASS] packaged PCB wrapper and save-only recovery with isolated EDA mock")
    print("[PASS] packaged host schematic contract audit is deterministic and provider-free")
    print("[PASS] isolated missing-adapter failure is clear and evidence-backed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
