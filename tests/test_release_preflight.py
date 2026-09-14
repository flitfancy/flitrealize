from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


@unittest.skipUnless(POWERSHELL and shutil.which("git"), "PowerShell and Git are required")
class PublishPreflightTests(unittest.TestCase):
    def test_unstaged_deletion_cannot_pass_publish_preflight(self) -> None:
        with tempfile.TemporaryDirectory(prefix="flitrealize-preflight-") as directory:
            scratch = Path(directory)
            repo = scratch / "repo"
            repo.mkdir()

            def git(*args: str) -> None:
                subprocess.run(["git", *args], cwd=repo, capture_output=True, check=True)

            git("init", "-b", "main")
            (repo / "change.txt").write_text("original", encoding="utf-8")
            (repo / "tracked-test.txt").write_text("original test", encoding="utf-8")
            git("add", ".")
            git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture")
            git("remote", "add", "origin", ".")
            (repo / "change.txt").write_text("reviewed staged change", encoding="utf-8")
            git("add", "change.txt")
            (repo / "tracked-test.txt").unlink()
            harness = scratch / "preflight.ps1"
            harness.write_text(r'''param([string]$ReleaseFile)
$ErrorActionPreference = 'Stop'
$Tokens = $null
$Errors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($ReleaseFile, [ref]$Tokens, [ref]$Errors)
foreach ($Name in @('Invoke-GitCapture', 'Assert-PublishPreflight')) {
    $Function = $Ast.Find({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name }, $true)
    . ([scriptblock]::Create($Function.Extent.Text))
}
try {
    Assert-PublishPreflight -ExpectedBranch main -RemoteName origin -TagName v-preflight-fixture
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
''', encoding="utf-8")
            completed = subprocess.run(
                [POWERSHELL, "-NoProfile", "-File", str(harness), str(ROOT / "scripts/release.ps1")],
                cwd=repo, text=True, capture_output=True, check=False,
            )
            self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
            self.assertIn("no unstaged or untracked files", completed.stderr)


if __name__ == "__main__":
    unittest.main()
