from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from package_release import runtime_files, write_archive


class PcbCreatePackagingTests(unittest.TestCase):
    def test_new_entrypoint_and_its_reused_runtime_ship(self) -> None:
        packaged = {file.relative_to(ROOT).as_posix() for file in runtime_files()}
        required = {
            "scripts/pcb-create.mjs",
            "scripts/actions/easyeda-pro/pcb-create.js",
            "scripts/pcb-layout/pcb-footprint-audit.mjs",
            "scripts/pcb-layout/pcb-layout-netlist.mjs",
            "scripts/providers/easyeda-pro/pcb-layout-native/source.js",
            "references/providers/easyeda-pro/3.1-pcb-create.md",
        }
        self.assertTrue(required <= packaged, sorted(required - packaged))
        self.assertNotIn("tests/pcb-create.test.mjs", packaged)

    def test_packaged_entrypoint_imports_and_shows_help_without_eda(self) -> None:
        node = shutil.which("node")
        if not node:
            self.skipTest("An existing Node runtime is required")
        with tempfile.TemporaryDirectory(prefix="flit-pcb-create-package-") as temporary:
            directory = Path(temporary).resolve()
            self.assertTrue(directory.is_relative_to(Path(tempfile.gettempdir()).resolve()))
            archive = directory / "runtime.zip"
            write_archive(archive, runtime_files())
            with zipfile.ZipFile(archive) as bundle:
                bundle.extractall(directory / "unpacked")
            root = directory / "unpacked/flitrealize"
            process = subprocess.run([node, str(root / "scripts/pcb-create.mjs"), "--help"], cwd=directory, capture_output=True, text=True, encoding="utf-8", timeout=10)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertIn("new PCB", process.stdout)
            self.assertIn("--resume", process.stdout)


if __name__ == "__main__":
    unittest.main()
