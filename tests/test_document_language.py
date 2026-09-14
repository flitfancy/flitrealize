from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from validate import english_backup_failures, runtime_document_failures
from package_release import runtime_files


class DocumentLanguageTests(unittest.TestCase):
    def snapshot(self, root: Path) -> Path:
        backup = root / "docs/en-backup"
        backup.mkdir(parents=True)
        contents = b"Historical English instructions.\n"
        (backup / "SKILL.md.bak").write_bytes(contents)
        (backup / "manifest.json").write_text(json.dumps({
            "schemaVersion": 1,
            "runtimeLanguage": "zh-CN",
            "snapshotLanguage": "en",
            "mode": "historical-reference-only",
            "files": [{"source": "SKILL.md", "backup": "SKILL.md.bak",
                       "sha256": hashlib.sha256(contents).hexdigest().upper()}],
        }), encoding="utf-8")
        return backup

    def test_chinese_changes_do_not_invalidate_historical_english(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.snapshot(root)
            (root / "SKILL.md").write_text("# 中文执行源\n", encoding="utf-8")
            self.assertEqual(english_backup_failures(root), [])
            (root / "SKILL.md").write_text("# 中文规则已经更新\n", encoding="utf-8")
            self.assertEqual(english_backup_failures(root), [])

    def test_changed_backup_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backup = self.snapshot(root)
            (backup / "SKILL.md.bak").write_text("Changed.\n", encoding="utf-8")
            self.assertTrue(english_backup_failures(root))

    def test_missing_and_unlisted_backups_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backup = self.snapshot(root)
            (backup / "SKILL.md.bak").rename(backup / "unexpected.md.bak")
            self.assertTrue(english_backup_failures(root))

    def test_traversal_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backup = self.snapshot(root)
            path = backup / "manifest.json"
            manifest = json.loads(path.read_text(encoding="utf-8"))
            manifest["files"][0]["backup"] = "../outside.md.bak"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            self.assertTrue(english_backup_failures(root))

    def test_runtime_routes_stay_out_of_inactive_copies(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "references").mkdir()
            (root / "references/current.md").write_text("# 当前规则\n", encoding="utf-8")
            path = root / "SKILL.md"
            path.write_text("[当前](references/current.md)\n", encoding="utf-8")
            self.assertEqual(runtime_document_failures(root), [])
            for target in ("docs/en-backup/SKILL.md.bak", "docs/zh-CN/SKILL.zh-CN.md"):
                path.write_text(f"[旧规则]({target})\n", encoding="utf-8")
                self.assertTrue(runtime_document_failures(root))

    def test_release_excludes_both_secondary_document_trees(self) -> None:
        packaged = {path.relative_to(ROOT).as_posix() for path in runtime_files()}
        self.assertIn("SKILL.md", packaged)
        self.assertIn("references/3.1-pcb-review.md", packaged)
        self.assertFalse(any(path.startswith("docs/") for path in packaged))

    def test_runtime_document_links_are_packaged(self) -> None:
        packaged = {path.resolve() for path in runtime_files()}
        missing = []
        for path in packaged:
            if path.suffix != ".md":
                continue
            for target in re.findall(r"\]\(([^)]+)\)", path.read_text(encoding="utf-8")):
                if target.startswith(("#", "http://", "https://", "mailto:")):
                    continue
                resolved = (path.parent / target.split("#", 1)[0]).resolve()
                if resolved not in packaged:
                    missing.append(f"{path.relative_to(ROOT)} -> {target}")
        self.assertEqual(missing, [])

    def test_discovery_references_and_entrypoints_are_packaged(self) -> None:
        packaged = {path.relative_to(ROOT).as_posix() for path in runtime_files()}
        manifest = json.loads((ROOT / 'scripts/actions/manifest.json').read_text(encoding='utf-8'))
        for record in [*manifest['actions'].values(), *manifest['workflows'].values()]:
            for field in ('reference', 'entrypoint'):
                value = record.get('discovery', {}).get(field)
                if value is not None:
                    self.assertIn(value, packaged)

    def test_retired_updater_fails_without_changing_snapshots(self) -> None:
        paths = list((ROOT / "docs/en-backup").rglob("*.bak"))
        before = {path: path.read_bytes() for path in paths}
        completed = subprocess.run(
            [sys.executable, "-X", "utf8", str(ROOT / "scripts/update_translation_hashes.py")],
            capture_output=True, check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("已停用", completed.stderr.decode("utf-8"))
        self.assertEqual(before, {path: path.read_bytes() for path in paths})


if __name__ == "__main__":
    unittest.main()
