# FlitRealize

**Carry a hardware project from its first idea to a tested prototype, keeping design decisions, evidence, and the next step together.**

[简体中文](README.zh-CN.md) · [First run](docs/first-run.md) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/flitfancy/flitrealize/releases)

Version marker: `v1.5.0`. See the [changelog](CHANGELOG.md) for source changes.

FlitRealize is an agent skill for requirements, parts, schematics, PCB work, manufacturing preparation, and prototype testing. The agent makes engineering judgments; scripts read, transform, calculate, execute, and verify. Each project keeps one `CURRENT_HANDOFF.md`; contracts, EDA files, and original evidence retain the underlying facts.

## Current capabilities

| Stage | Supported work |
| --- | --- |
| Requirements and parts | Architecture, power and interface relationships, part identity, datasheets, and inventory matching |
| Schematics | Design contracts, library identity checks, batch placement, connections, reflow, saving, and checks |
| PCB | Input preparation, multiple layout starts, spacing and edge checks, applying selected candidates; outlines, explicit moves, trace widths, grounding, and colors |
| Manufacturing and prototypes | Source/output alignment, BOM/CPL handoff, measurement plans, results, and revision decisions |
| Continuity | One project manuscript and the local View State panel |

EasyEDA Pro is the implemented live provider. Other EDA software needs its own provider. Routing plans do not run an autorouter; layout scores do not certify return paths, thermal performance, or full-board DRC. See the [stage guides](references/0.0-overview.md) for each operation's scope.

## Get started

Install the repository in your host's skill directory, with `SKILL.md` directly inside `flitrealize/`. Open a new task after installation:

```text
$flitrealize Start a hardware project in <PROJECT_ROOT>.
For this task, develop requirements, architecture, and part candidates.
```

Continue using the same project directory:

```text
$flitrealize Continue <PROJECT_ROOT>.
Read the current handoff and work on its PCB placement issues.
```

Keep project files separate from the skill. Installation, runtime requirements, and EDA setup are in the [first-run guide](docs/first-run.md).

View State opens when starting a project or first taking it over, unless the user opts out. It displays the manuscript without modifying project files and refreshes as the manuscript changes. See [View State](view-state/README.md).

## Structure

| Part | Responsibility |
| --- | --- |
| `SKILL.md` | Common working rules and stage selection |
| `references/` | Engineering guidance, input contracts, and operation guides |
| CLI and Action manifest | Capability discovery, inputs, execution, and evidence |
| `scripts/` and `schemas/` | Reusable computation, validation, and provider implementations |

Providers convert native identities, layers, coordinates, pin mappings, and netlists. Transport code lives in `adapters/`. Project settings and run evidence stay outside reusable scripts. Chinese execution guides are maintained; `docs/en-backup/` is a fixed historical snapshot.

## Develop and verify

Tools and View State require Node.js 22+. Validation and packaging also require Python 3.10+. In a source checkout:

```sh
python scripts/validate.py
npm test
python -m unittest discover -s tests -p "test_*.py"
```

Use `./scripts/release.ps1 -DryRun` for the complete local release check. Runtime packages include tools and the panel, but exclude tests, project records, and `node_modules`. See [Action and provider development](development/action-system.md).

[MIT](LICENSE) · Copyright (c) 2026 FlitFancy.
