[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Publish,
    [string]$Message,
    [string]$Remote = "origin",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if ($DryRun -and $Publish) {
    throw "Choose either -DryRun or -Publish, not both."
}
if ($Publish -and [string]::IsNullOrWhiteSpace($Message)) {
    throw "-Publish requires a non-empty -Message."
}

function Invoke-GitCapture {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $PreviousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 wraps ordinary native stderr (including
        # successful git push progress) as ErrorRecord objects.
        $ErrorActionPreference = "Continue"
        $Output = @(& git @Arguments 2>&1)
        $ExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousPreference
    }
    if ($ExitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed: $($Output -join [Environment]::NewLine)"
    }
    return $Output
}

function Assert-PublishPreflight {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedBranch,
        [Parameter(Mandatory = $true)][string]$RemoteName,
        [Parameter(Mandatory = $true)][string]$TagName
    )

    $CurrentBranch = (Invoke-GitCapture @("branch", "--show-current") | Select-Object -First 1).Trim()
    if ($CurrentBranch -ne $ExpectedBranch) {
        throw "Publishing requires branch '$ExpectedBranch'; current branch is '$CurrentBranch'."
    }

    & git remote get-url $RemoteName *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Git remote '$RemoteName' is not configured."
    }

    $Staged = @(@(Invoke-GitCapture @("diff", "--cached", "--name-only", "--diff-filter=ACMR", "--")) |
        Where-Object { $_ })
    $Unstaged = @(@(Invoke-GitCapture @("diff", "--name-only", "--diff-filter=ACMR", "--")) |
        Where-Object { $_ })
    $Untracked = @(@(Invoke-GitCapture @("ls-files", "--others", "--exclude-standard")) |
        Where-Object { $_ })
    if ($Staged.Count -eq 0) {
        throw "Publishing requires an explicitly reviewed staged change set."
    }
    if ($Unstaged.Count -gt 0 -or $Untracked.Count -gt 0) {
        throw "Publishing requires no unstaged or untracked files. Review and stage intended files explicitly."
    }

    Invoke-GitCapture @("diff", "--cached", "--check") | Out-Null
    Invoke-GitCapture @("fetch", "--tags", "--quiet", $RemoteName) | Out-Null

    & git rev-parse -q --verify "refs/tags/$TagName" *> $null
    if ($LASTEXITCODE -eq 0) {
        throw "Local tag '$TagName' already exists."
    }
    $RemoteTag = @(@(Invoke-GitCapture @("ls-remote", "--tags", $RemoteName, "refs/tags/$TagName")) |
        Where-Object { $_ })
    if ($RemoteTag.Count -gt 0) {
        throw "Remote tag '$TagName' already exists."
    }
}

function Resolve-PythonRuntime {
    $Candidates = @()
    if ($env:FLITREALIZE_PYTHON) {
        $Candidates += [pscustomobject]@{ File = $env:FLITREALIZE_PYTHON; Prefix = @() }
    }
    $Candidates += [pscustomobject]@{ File = "py"; Prefix = @("-3") }
    $Candidates += [pscustomobject]@{ File = "python3"; Prefix = @() }
    $Candidates += [pscustomobject]@{ File = "python"; Prefix = @() }

    foreach ($Candidate in $Candidates) {
        if (-not (Get-Command $Candidate.File -ErrorAction SilentlyContinue)) {
            continue
        }
        $Prefix = @($Candidate.Prefix)
        & $Candidate.File @Prefix --version *> $null
        if ($LASTEXITCODE -eq 0) {
            return $Candidate
        }
    }
    throw "No working Python 3 runtime. Set FLITREALIZE_PYTHON to an explicit executable path."
}

function Invoke-PythonScript {
    param(
        [Parameter(Mandatory = $true)]$Runtime,
        [Parameter(Mandatory = $true)][string]$Script
    )
    $Prefix = @($Runtime.Prefix)
    & $Runtime.File @Prefix $Script
    if ($LASTEXITCODE -ne 0) {
        throw "Release check failed in $Script"
    }
}

$PythonRuntime = Resolve-PythonRuntime
if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    throw "Node.js is required for Action regression tests."
}

Push-Location $RepositoryRoot
try {
    if (-not (Get-Command "git" -ErrorAction SilentlyContinue)) {
        throw "Git is required for release checks and publishing."
    }

    $Version = (Get-Content -LiteralPath "VERSION" -Raw -Encoding UTF8).Trim()
    $TagName = "v$Version"
    $Mode = if ($Publish) { "publish" } else { "check-only" }
    Write-Host "FlitRealize release $Mode ($TagName)"

    if ($Publish) {
        Assert-PublishPreflight -ExpectedBranch $Branch -RemoteName $Remote -TagName $TagName
    }

    Invoke-PythonScript $PythonRuntime "scripts/validate.py"

    & node "scripts/run-tests.mjs"
    if ($LASTEXITCODE -ne 0) {
        throw "Node Action tests failed"
    }

    $Prefix = @($PythonRuntime.Prefix)
    & $PythonRuntime.File @Prefix -m unittest discover -s tests -p "test_*.py"
    if ($LASTEXITCODE -ne 0) {
        throw "Release-tool tests failed"
    }

    Invoke-PythonScript $PythonRuntime "scripts/package_release.py"
    Invoke-PythonScript $PythonRuntime "scripts/check_release.py"
    Invoke-PythonScript $PythonRuntime "scripts/smoke_test_release.py"
    Invoke-PythonScript $PythonRuntime "scripts/scan_staged_secrets.py"

    if (-not $Publish) {
        $Staged = @(@(& git diff --cached --name-only --diff-filter=ACMR --) | Where-Object { $_ })
        if ($Staged.Count -eq 0) {
            Write-Warning "No files are staged; the staged-secret check did not cover working-tree changes."
        }
        Write-Host "READY: deterministic checks passed. Re-run with -Publish and -Message only after explicit authorization."
        return
    }

    Invoke-GitCapture @("commit", "-m", $Message) | ForEach-Object { Write-Host $_ }
    Invoke-GitCapture @("tag", "-a", $TagName, "-m", "FlitRealize T1 $TagName") | Out-Null

    $Pushed = $false
    for ($Attempt = 1; $Attempt -le 2; $Attempt++) {
        $PreviousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $PushOutput = @(& git push --atomic --set-upstream $Remote $Branch "refs/tags/$TagName" 2>&1)
            $PushExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $PreviousPreference
        }
        if ($PushExitCode -eq 0) {
            $PushOutput | ForEach-Object { Write-Host $_ }
            $Pushed = $true
            break
        }
        if ($Attempt -lt 2) {
            Write-Warning "Atomic push failed; retrying once in 5 seconds."
            Start-Sleep -Seconds 5
        }
    }
    if (-not $Pushed) {
        throw "Atomic push failed twice. The local commit and tag remain for inspection; no automatic rollback was performed."
    }

    Write-Host "PUBLISHED: $TagName pushed to $Remote/$Branch."
    Write-Host "NEXT: wait for GitHub Actions, then create a Pre-release and attach dist/flitrealize-$Version.zip plus its .sha256 sidecar."
}
finally {
    Pop-Location
}
