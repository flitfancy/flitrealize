# FlitRealize

**Develop a hardware project from requirements and part selection through prototype validation.**

[简体中文](README.zh-CN.md) · [First run](first-run.md) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/flitfancy/flitrealize/releases)

FlitRealize is a skill for developing electronic hardware projects. Start at the project's current stage and keep the design rationale, actual results, and open issues so work can continue.

Current release: `v3.0.0`. Changes are in the [release notes](CHANGELOG.md#300---2026-10-14).

## Start or continue

Put the repository in the host's skill directory, with `SKILL.md` directly inside `flitrealize/`. Open a new task after installation:

```text
$flitrealize Start a hardware project in <PROJECT_ROOT>; develop requirements, architecture, and part candidates.
$flitrealize Continue <PROJECT_ROOT> and work on its current PCB placement issues.
```

Keep the project separate from the skill. Each project has one `CURRENT_HANDOFF.md`: the top records the current design, results, blockers, and next step; the body keeps design reasons and evidence links. Circuit design drafts (电路设计稿), EDA files, and original reports hold connection and geometry facts.

For ordinary continuation, read the handoff top, relevant chapters, and the current operation guide. See [the main entry](SKILL.md) for the workflow and discovery, the [stage map](docs/0.0-overview.md) for transitions, and [first run](first-run.md) for dependencies and channels. [View State](view-state/README.md) provides a read-only project panel, opened at project creation or first takeover and reused afterward.

## Scope

Work covers requirements and part selection, schematic design, PCB placement and routing, manufacturing preparation, and prototype power-up, functional tests, and revisions. The agent makes circuit and engineering decisions; existing scripts handle repeatable searches, conversion, placement, connections, and readback.

EasyEDA Pro is currently supported through the desktop official CLI or the web/desktop Bridge. Work follows the user's current request, with candidates, actual changes, saved designs, and validation results recorded separately.

See the [stage guides](docs/0.0-overview.md) for the workflow. Specific algorithms, commands, support conditions, and verification limits are documented in the [technical references](docs/technical/).

## Develop and verify

Use Node.js 22+. Repository validation and packaging use Python 3.10+. Numerical backends need Python 3.12+ and [pinned dependencies](requirements-pcb.txt); configure them through [first run](first-run.md#数值与路由环境). In a source checkout:

```sh
python scripts/validate.py
npm test
python -m unittest discover -s tests -p "test_*.py"
```

Numerical tests need the configured interpreter. Bridge integration tests need the channel dependencies. `./scripts/release.ps1 -DryRun` runs repository, regression, and clean ZIP checks. See [Action and provider development](docs/0.6-tool-development.md) for development conventions.

There is one Chinese execution source: `SKILL.md` and `docs/`. The root `first-run.md` covers setup; stage, technical, provider, domain, and development guides live under `docs/`. Runtime packages contain tools, guides, the dependency manifest, and the panel; project records, tests, and installed dependency directories stay outside the package.

[MIT](LICENSE) · Copyright (c) 2026 FlitFancy.
