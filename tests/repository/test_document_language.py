from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from validate import runtime_document_failures
from package_release import runtime_files


class DocumentLanguageTests(unittest.TestCase):
    def test_runtime_routes_stay_out_of_inactive_copies(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs").mkdir()
            (root / "docs/current.md").write_text("# 当前规则\n", encoding="utf-8")
            (root / "first-run.md").write_text("# Setup\n", encoding="utf-8")
            path = root / "SKILL.md"
            path.write_text("[当前](docs/current.md)\n", encoding="utf-8")
            self.assertEqual(runtime_document_failures(root), [])
            for target in ("docs/en-backup/SKILL.md.bak", "docs/zh-CN/SKILL.zh-CN.md"):
                path.write_text(f"[旧规则]({target})\n", encoding="utf-8")
                self.assertTrue(runtime_document_failures(root))

    def test_release_uses_the_unified_document_tree(self) -> None:
        packaged = {path.relative_to(ROOT).as_posix() for path in runtime_files()}
        self.assertIn("SKILL.md", packaged)
        self.assertIn("docs/3.1-pcb-review.md", packaged)
        self.assertIn("first-run.md", packaged)
        self.assertIn("docs/0.6-tool-development.md", packaged)
        self.assertIn("docs/providers/easyeda-pro/3.1-r-pcb-create.md", packaged)
        self.assertIn("docs/providers/easyeda-pro/3.8-r-pcb-autorouting.md", packaged)
        removed_paths = {
            "docs/pcb-layout-inputs.md", "docs/3.3-ground-space.md",
            "docs/providers/easyeda-pro/3.3-ground-space.md",
            "docs/providers/easyeda-pro/3.3-pcb-grounding.md",
            "docs/providers/easyeda-pro/3.5.1-block-layout.md",
            "docs/providers/easyeda-pro/3.8-prerouting.md",
            "docs/providers/easyeda-pro/3.1-pcb-create.md",
            "docs/providers/easyeda-pro/3.8-autorouting.md",
        }
        self.assertFalse(removed_paths & packaged)
        self.assertFalse(any(path.startswith(("references/", "development/")) for path in packaged))
        self.assertFalse(any(path.startswith(("docs/en-backup/", "docs/zh-CN/")) for path in packaged))

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

if __name__ == "__main__":
    unittest.main()
