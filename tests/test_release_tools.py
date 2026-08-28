from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import scan_staged_secrets
from extract_release_notes import extract_version_notes
from package_release import (
    FIXED_TIME,
    ZIP_CREATE_SYSTEM,
    ZIP_VERSION,
    runtime_files,
    write_archive,
)


class RuntimePackagingTests(unittest.TestCase):
    def test_nested_provider_references_are_packaged(self) -> None:
        packaged = {path.relative_to(ROOT).as_posix() for path in runtime_files()}
        self.assertIn(
            "references/providers/easyeda-pro/environment.md",
            packaged,
        )
        self.assertIn(
            "references/providers/easyeda-pro/pcb-foundation.md",
            packaged,
        )
        self.assertIn(
            "references/providers/easyeda-pro/pcb-grounding.md",
            packaged,
        )

    def test_archive_bytes_and_metadata_are_platform_independent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            notes = root / "notes" / "readme.md"
            tool = root / "scripts" / "tool.mjs"
            notes.parent.mkdir(parents=True)
            tool.parent.mkdir(parents=True)
            notes.write_bytes(b"alpha\n")
            tool.write_bytes(b"export default 1;\n")

            first = Path(temporary) / "first.zip"
            second = Path(temporary) / "second.zip"
            write_archive(first, [tool, notes], root=root, archive_root="fixture")
            write_archive(second, [notes, tool], root=root, archive_root="fixture")

            first_bytes = first.read_bytes()
            self.assertEqual(first_bytes, second.read_bytes())
            self.assertEqual(
                hashlib.sha256(first_bytes).hexdigest(),
                "d4204573d5296bd90262d8810df87f5f54991e489cfc0b10498a674bec58ed53",
            )

            with zipfile.ZipFile(first) as bundle:
                self.assertEqual(bundle.comment, b"")
                self.assertEqual(
                    [info.filename for info in bundle.infolist()],
                    ["fixture/notes/readme.md", "fixture/scripts/tool.mjs"],
                )
                for info in bundle.infolist():
                    self.assertEqual(info.date_time, FIXED_TIME)
                    self.assertEqual(info.compress_type, zipfile.ZIP_STORED)
                    self.assertEqual(info.create_system, ZIP_CREATE_SYSTEM)
                    self.assertEqual(info.create_version, ZIP_VERSION)
                    self.assertEqual(info.extract_version, ZIP_VERSION)
                    self.assertEqual(info.extra, b"")
                    self.assertEqual(info.comment, b"")

                modes = {
                    info.filename: info.external_attr >> 16
                    for info in bundle.infolist()
                }
                self.assertEqual(modes["fixture/notes/readme.md"], 0o100644)
                self.assertEqual(modes["fixture/scripts/tool.mjs"], 0o100755)


class StagedSecretScanTests(unittest.TestCase):
    def test_added_line_locations(self) -> None:
        diff = "\n".join(
            [
                "diff --git a/example.txt b/example.txt",
                "--- a/example.txt",
                "+++ b/example.txt",
                "@@ -2,0 +3,2 @@",
                "+first",
                "+second",
            ]
        )
        self.assertEqual(
            scan_staged_secrets.staged_added_lines(diff),
            [("example.txt", 3, "first"), ("example.txt", 4, "second")],
        )

    def test_representative_secrets_match_without_printing_values(self) -> None:
        windows_path = "C:" + "\\Users\\Example\\private"
        samples = {
            "private-key": "-----BEGIN " + "PRIVATE KEY-----",
            "github-token": "github_pat_" + "A" * 30,
            "aws-access-key": "AKIA" + "A" * 16,
            "credential-assignment": "password=" + "A" * 20,
            "windows-user-path": windows_path,
        }
        patterns = dict(scan_staged_secrets.RULES)
        for rule_name, sample in samples.items():
            with self.subTest(rule=rule_name):
                self.assertRegex(sample, patterns[rule_name])

    def test_ordinary_public_text_is_not_a_secret(self) -> None:
        text = "Run node scripts/action-runner.mjs with a project-local JSON input."
        matched = [name for name, pattern in scan_staged_secrets.RULES if pattern.search(text)]
        self.assertEqual(matched, [])

    def test_first_push_zero_revision_maps_to_empty_tree(self) -> None:
        self.assertEqual(
            scan_staged_secrets.normalize_base_revision("0" * 40),
            scan_staged_secrets.EMPTY_TREE,
        )

    def test_private_names_are_case_insensitive(self) -> None:
        self.assertIn("battle_log.md", scan_staged_secrets.PRIVATE_NAMES)
        self.assertIn("catalog.csv", scan_staged_secrets.PRIVATE_NAMES)

    def test_github_push_event_resolves_without_shell_syntax(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            event_path = Path(temporary) / "event.json"
            event_path.write_text(json.dumps({"before": "a" * 40}), encoding="utf-8")
            environment = {
                "GITHUB_EVENT_NAME": "push",
                "GITHUB_EVENT_PATH": str(event_path),
                "GITHUB_SHA": "b" * 40,
            }
            self.assertEqual(
                scan_staged_secrets.github_revision_range(environment),
                ["a" * 40, "b" * 40],
            )

    def test_github_pull_request_event_uses_base_sha(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            event_path = Path(temporary) / "event.json"
            event_path.write_text(
                json.dumps({"pull_request": {"base": {"sha": "c" * 40}}}),
                encoding="utf-8",
            )
            environment = {
                "GITHUB_EVENT_NAME": "pull_request",
                "GITHUB_EVENT_PATH": str(event_path),
                "GITHUB_SHA": "d" * 40,
            }
            self.assertEqual(
                scan_staged_secrets.github_revision_range(environment),
                ["c" * 40, "d" * 40],
            )


class ReleaseNotesTests(unittest.TestCase):
    def test_extracts_only_requested_version_body(self) -> None:
        changelog = """# Changelog

## [Unreleased]

## [1.2.3-test.1] - 2026-08-27

### Added

- Current notes.

## [1.2.2] - 2026-08-20

- Older notes.
"""
        self.assertEqual(
            extract_version_notes(changelog, "1.2.3-test.1"),
            "### Added\n\n- Current notes.\n",
        )

    def test_missing_version_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing from CHANGELOG"):
            extract_version_notes("# Changelog\n", "9.9.9")


if __name__ == "__main__":
    unittest.main()
