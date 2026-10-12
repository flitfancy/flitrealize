# FlitRealize

**Carry a hardware idea to a testable prototype. Keep the design reasons, results, and next step.**

[简体中文](README.zh-CN.md) · [First run](docs/first-run.md) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/flitfancy/flitrealize/releases)

One skill connects requirements, parts, schematics, PCB work, manufacturing preparation, and prototype tests. The agent makes engineering decisions. Scripts handle repeatable computation, execution, and readback.

The version file is `v2.0.0`. Current source changes and verification results are under [Unreleased](CHANGELOG.md#unreleased).

## Start or continue

Put the repository in the host's skill directory, with `SKILL.md` directly inside `flitrealize/`. Open a new task after installation:

```text
$flitrealize Start a hardware project in <PROJECT_ROOT>; develop requirements, architecture, and part candidates.
$flitrealize Continue <PROJECT_ROOT> and work on its current PCB placement issues.
```

Keep the project separate from the skill. Each project has one `CURRENT_HANDOFF.md`: the top records the current design, results, blockers, and next step; the body keeps design reasons and evidence links. Contracts, EDA files, and original reports hold connection and geometry facts.

For ordinary continuation, read the handoff top, relevant chapters, and the current operation guide. See [the main entry](SKILL.md) for the workflow and discovery, the [stage map](references/0.0-overview.md) for transitions, and [first run](docs/first-run.md) for dependencies and channels. [View State](view-state/README.md) provides a read-only project panel, opened at project creation or first takeover and reused afterward.

## Scope

Coarse placement arranges blocks. Fine placement arranges clusters and parts. Routing connects nets and feeds problems back. Enter at the project's current stage; the corresponding technical reference defines fields, commands, and support conditions.

EasyEDA Pro is the current live implementation, with desktop official CLI and web/desktop Bridge support. Other EDA software needs its own implementation. Automatic block-region allocation, automatic part selection and movement from routing failures, and an automatic loop for the whole flow remain to be implemented.

Candidates, writes, saving, connectivity, DRC, electrical checks, and prototype measurements are recorded separately. Two-dimensional geometry, connection distance, or trial-routing success cannot replace checks of return paths, current capacity, heat, mechanics, or manufacturing. Real SDK label bounds still need a live check. See the [fine-placement interface](references/technical/pcb-fine-layout-execution.md#验证记录) and [PCB-creation verification scope](references/providers/easyeda-pro/3.1-pcb-create.md#当前验证范围) for limits, and the [changelog](CHANGELOG.md#unreleased) for detailed changes and regression results.

## Develop and verify

Use Node.js 22+. Repository validation and packaging use Python 3.10+. Numerical backends need Python 3.12+ and [pinned dependencies](requirements-pcb.txt); configure them through [first run](docs/first-run.md#数值与路由环境). In a source checkout:

```sh
python scripts/validate.py
npm test
python -m unittest discover -s tests -p "test_*.py"
```

Numerical tests need the configured interpreter. Bridge integration tests need the channel dependencies. `./scripts/release.ps1 -DryRun` runs repository, regression, and clean ZIP checks. See [Action and provider development](development/action-system.md) for development conventions.

There is one Chinese execution source. `docs/zh-CN` keeps compatibility redirects; `docs/en-backup` keeps a fixed historical snapshot. Runtime packages contain tools, guides, the dependency manifest, and the panel; project records, tests, and installed dependency directories stay outside the package.

[MIT](LICENSE) · Copyright (c) 2026 FlitFancy.
