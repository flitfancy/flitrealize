from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from validate import action_registry_failures, reference_routing_failures


class RegistryValidationTests(unittest.TestCase):
    def fixture(self, directory: str) -> tuple[Path, dict]:
        root = Path(directory)
        (root / "scripts/actions").mkdir(parents=True)
        shutil.copyfile(ROOT / "scripts/action-runner.mjs", root / "scripts/action-runner.mjs")
        (root / "scripts/lib").mkdir()
        shutil.copyfile(ROOT / "scripts/lib/state-paths.mjs", root / "scripts/lib/state-paths.mjs")
        shutil.copyfile(ROOT / "scripts/lib/cli-entrypoint.mjs", root / "scripts/lib/cli-entrypoint.mjs")
        (root / "VERSION").write_text("1.0.0", encoding="utf-8")
        (root / "scripts/actions/fixture.js").write_text("return {};", encoding="utf-8")
        manifest = {"schemaVersion": 2, "providers": {}, "actions": {"fixture": {
            "file": "fixture.js", "description": "Fixture", "contractVersion": 1, "domain": "pcb",
            "runtime": "host", "providers": [], "defaultMode": "generate", "modes": {"generate": {"mutates": False}},
        }}}
        self.write_manifest(root, manifest)
        return root, manifest

    def write_manifest(self, root: Path, manifest: dict) -> None:
        (root / "scripts/actions/manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def test_discovery_validation_uses_the_actual_runner_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, manifest = self.fixture(directory)
            self.assertEqual(action_registry_failures(root), [])
            manifest["actions"]["fixture"]["discovery"] = {"reference": "references/missing.md"}
            self.write_manifest(root, manifest)
            self.assertIn("INVALID_DISCOVERY_METADATA", " ".join(action_registry_failures(root)))

    def test_python_retains_exact_action_file_inventory_validation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, manifest = self.fixture(directory)
            (root / "scripts/actions/extra.js").write_text("return {};", encoding="utf-8")
            self.assertIn("unregistered: extra.js", action_registry_failures(root))
            manifest["actions"]["fixture"]["file"] = "missing.js"
            self.write_manifest(root, manifest)
            self.assertIn("missing files: missing.js", action_registry_failures(root))


class ReferenceRoutingTests(unittest.TestCase):
    def fixture(self, directory: str, reachable: bool = True) -> tuple[Path, Path]:
        root = Path(directory)
        legacy = root / "references/providers/easyeda-pro/3.4-block-layout.md"
        legacy.parent.mkdir(parents=True)
        (root / "references/3.4-block-layout.md").write_text("# 功能块布局\n", encoding="utf-8")
        (root / "SKILL.md").write_text(
            "# Skill\n" + ("[通用布局](references/3.4-block-layout.md)\n" if reachable else ""),
            encoding="utf-8",
        )
        legacy.write_text(
            "# 3.4 功能块布局已迁移\n\n"
            "请阅读并维护 [通用说明](../../3.4-block-layout.md)。本路径仅保留兼容跳转。\n",
            encoding="utf-8",
        )
        return root, legacy

    def test_strict_redirect_accepts_only_a_reachable_canonical_page(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.fixture(directory)
            self.assertEqual(reference_routing_failures(root), [])
            (root / "SKILL.md").write_text("# Skill\n", encoding="utf-8")
            self.assertEqual(reference_routing_failures(root), [
                "3.4-block-layout.md", "providers/easyeda-pro/3.4-block-layout.md",
            ])

    def test_old_directory_does_not_exempt_arbitrary_or_multi_content_pages(self) -> None:
        mutations = [
            "# 旧说明\n\n[布局](../../3.4-block-layout.md)\n",
            "# 3.4 功能块布局已迁移\n\n请阅读并维护 [通用说明](../../3.4-block-layout.md)。兼容页面。\n",
            "# 3.4 功能块布局已迁移\n\n请阅读并维护 [通用说明](../../3.4-block-layout.md)。本路径仅保留兼容跳转。\n额外规则\n",
            "# 3.4 功能块布局已迁移\n\n请阅读并维护 [通用说明](../../3.4-block-layout.md)。本路径仅保留兼容跳转。 [第二链接](../../3.4-block-layout.md)\n",
        ]
        for content in mutations:
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                root, legacy = self.fixture(directory)
                legacy.write_text(content, encoding="utf-8")
                self.assertEqual(reference_routing_failures(root), ["providers/easyeda-pro/3.4-block-layout.md"])

    def test_redirect_rejects_missing_targets_and_noncanonical_aliases(self) -> None:
        for target in ["../../missing.md", "https://example.com/guide", "../../../SKILL.md", "../../other.md"]:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                root, legacy = self.fixture(directory)
                (root / "references/other.md").write_text("# Other\n", encoding="utf-8")
                with (root / "SKILL.md").open("a", encoding="utf-8") as out:
                    out.write("[Other](references/other.md)\n")
                legacy.write_text(
                    f"# 3.4 功能块布局已迁移\n\n请阅读并维护 [通用说明]({target})。本路径仅保留兼容跳转。\n",
                    encoding="utf-8",
                )
                self.assertEqual(reference_routing_failures(root), ["providers/easyeda-pro/3.4-block-layout.md"])


if __name__ == "__main__":
    unittest.main()
