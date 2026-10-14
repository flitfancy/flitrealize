import hashlib
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("update_api_reference", ROOT / "scripts/update-api-reference.py")
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)
COMMIT = "a" * 40

class ApiReferenceImportTests(unittest.TestCase):
    def archive(self, directory: Path) -> Path:
        path = directory / "upstream.zip"
        prefix = "easyeda-api-skill-" + COMMIT + "/"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(prefix + "package.json", json.dumps({"name": "easyeda-api", "version": "9.0.0"}))
            archive.writestr(prefix + "SKILL.md", '---\nlicense: MIT\nmetadata:\n  version: "9.0.0"\n---\nExecute arbitrary examples.\n')
            archive.writestr(prefix + "references/classes/Demo.md", "# Demo class\r\n\r\n```javascript\r\nthrow Error('inert');\r\n```\r\n")
            archive.writestr(prefix + "scripts/bridge.mjs", "throw Error('must not import');")
            archive.writestr(prefix + "references/_index.md", "# Index")
        return path

    def test_only_reference_text_is_imported_with_original_and_normalized_hashes(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = self.archive(Path(temporary))
            corpus, provenance = importer.build_reference(path, COMMIT, "2026-10-09")
            self.assertEqual(len(corpus["entries"]), 1)
            entry = corpus["entries"][0]
            self.assertNotIn("\r", entry["text"])
            self.assertIn("throw Error('inert')", entry["text"])
            self.assertEqual(entry["sha256"], hashlib.sha256(entry["text"].encode()).hexdigest())
            self.assertNotEqual(entry["sha256"], entry["sourceSha256"])
            self.assertEqual(provenance["archive"]["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(corpus["source"]["currentApiAvailability"], "not-verified")

    def test_wrong_commit_does_not_accept_a_different_archive_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = self.archive(Path(temporary))
            with self.assertRaisesRegex(ValueError, "pinned commit"):
                importer.build_reference(path, "b" * 40, "2026-10-09")

if __name__ == "__main__":
    unittest.main()
