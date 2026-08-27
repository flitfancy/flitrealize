from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import scan_staged_secrets
from extract_release_notes import extract_version_notes


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
