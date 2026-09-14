from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from validate import action_registry_failures


class RegistryValidationTests(unittest.TestCase):
    def fixture(self, directory: str) -> tuple[Path, dict]:
        root = Path(directory)
        (root / "scripts/actions").mkdir(parents=True)
        shutil.copyfile(ROOT / "scripts/action-runner.mjs", root / "scripts/action-runner.mjs")
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


if __name__ == "__main__":
    unittest.main()
