from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import scan_staged_secrets


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


if __name__ == "__main__":
    unittest.main()
