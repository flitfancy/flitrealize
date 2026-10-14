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
            manifest["actions"]["fixture"]["discovery"] = {"reference": "docs/missing.md"}
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
    def fixture(self, directory: str) -> tuple[Path, Path]:
        root = Path(directory)
        stage = root / "docs/3.5.1-block-layout.md"
        stage.parent.mkdir(parents=True)
        stage.write_text("# 功能块布局\n", encoding="utf-8")
        (root / "SKILL.md").write_text("[布局](docs/3.5.1-block-layout.md)\n", encoding="utf-8")
        provider = root / "docs/providers/easyeda-pro/unused-guide.md"
        provider.parent.mkdir(parents=True)
        return root, provider

    def test_all_current_pages_require_a_route_from_skill(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, provider = self.fixture(directory)
            provider.write_text("# 操作说明\n", encoding="utf-8")
            self.assertEqual(reference_routing_failures(root), ["providers/easyeda-pro/unused-guide.md"])
            (root / "docs/3.5.1-block-layout.md").write_text(
                "# 功能块布局\n[操作](providers/easyeda-pro/unused-guide.md)\n", encoding="utf-8",
            )
            self.assertEqual(reference_routing_failures(root), [])

    def test_schema_pages_follow_the_same_reference_graph(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.fixture(directory)
            schema = root / "schemas/pcb-layout.md"
            schema.parent.mkdir()
            schema.write_text("# 布局数据\n", encoding="utf-8")
            self.assertEqual(reference_routing_failures(root), ["schemas/pcb-layout.md"])
            (root / "docs/3.5.1-block-layout.md").write_text(
                "# 功能块布局\n[数据](../schemas/pcb-layout.md)\n", encoding="utf-8",
            )
            self.assertEqual(reference_routing_failures(root), [])


if __name__ == "__main__":
    unittest.main()
