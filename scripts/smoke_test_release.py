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

        list_result = run(
            [node, str(extracted_root / "scripts/action-runner.mjs"), "list"],
            cwd=extracted_root,
        )
        if list_result.returncode != 0:
            fail(f"Packaged action registry failed: {list_result.stderr.strip()}")
        listed = json.loads(list_result.stdout)
        if (
            listed.get("schemaVersion") != 1
            or listed.get("skillVersion") != version
            or not listed.get("actions")
        ):
            fail("Packaged action registry returned an incomplete interface")

        isolated_state = temporary_root / "isolated-host-state"
        environment = os.environ.copy()
        environment["FLITREALIZE_HOME"] = str(isolated_state)
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
    print("[PASS] isolated missing-adapter failure is clear and evidence-backed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
