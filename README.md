# FlitRealize

**Carry a hardware project from its first idea to a tested prototype, with a useful handoff between tasks.**

[简体中文](README.zh-CN.md) · [First run](docs/first-run.md) · [View State](view-state/README.md) · [Changelog](CHANGELOG.md)

FlitRealize is an agent skill for requirements, parts, schematics, PCB work, manufacturing preparation, and prototype bring-up. It combines engineering guidance, reusable EasyEDA Pro actions, and **View State**, a local browser panel for the project's current handoff.

Each project keeps one `CURRENT_HANDOFF.md`: the current objective at the top, followed by design decisions, constraints, sources, and verification results. The skill advances the stage you request and preserves context for the next task.

> **Current release: `v1.3.1`** — View State opens when the skill starts a new project or first takes over an existing one. Includes the viewer and PCB color workflows introduced in v1.3.0. [Download the runtime ZIP](https://github.com/flitfancy/flitrealize/releases/tag/v1.3.1) · [Release notes](CHANGELOG.md#131---2026-09-20).

## What you can do

| Area | Supported work |
| --- | --- |
| Requirements and parts | Architecture, interfaces, power relationships, part identity, datasheets, and inventory matching |
| Schematics | Portable design contracts, pin/net checks, batch placement, connections, reflow, and readback |
| PCB | Board outlines, placement candidates, clearances, selected trace widths, grounding tools, and net-class colors |
| Manufacturing and bring-up | Source/output alignment, BOM/CPL handoff, measurements, unresolved issues, and revision decisions |
| Project continuity | One project manuscript, derived fact tables, and checks that separate recorded evidence from current verification |
| View State | Stage navigation, written summaries, original-document reading, language switching, and local bridge status |

EasyEDA Pro is the implemented EDA provider. Requirements, parts, calculations, and design contracts can be developed without it. EDA actions need the desktop client, API Gateway, and the included adapter channel; see the [first-run guide](docs/first-run.md).

Routing plans describe order and constraints; they do not run an autorouter. Physical bring-up requires the board and instruments. Plans, EDA readback, saved files, DRC, and measured hardware results remain separate evidence.

## Get started

Install this repository with your host's skill installer, or clone it into its skill directory with `SKILL.md` directly inside `flitrealize/`. A common location is `$HOME/.agents/skills/flitrealize`. Open a new task after installation and invoke `$flitrealize`.

Start a project:

```text
$flitrealize Start a hardware project in <PROJECT_ROOT>.
For this task, develop requirements, architecture, and part candidates.
Record the design and next step in CURRENT_HANDOFF.md.
```

Continue a project:

```text
$flitrealize Continue the hardware project in <PROJECT_ROOT>.
Read CURRENT_HANDOFF.md and work on the PCB placement issues recorded there.
Update the affected design sections and their ViewState summaries.
```

Keep the project directory separate from the skill repository. Topic-specific guidance such as [audio systems](references/domains/D.1-audio-systems.md) is loaded only where relevant.

## View State

View State ships in **this repository and newly built runtime ZIPs** under `view-state/`. It needs Node.js 22+ and a browser, with no third-party npm runtime dependencies or build step.

The skill opens the project's panel after confirming the project directory when starting a new project or first taking over an existing one. It reuses an existing service, respects an explicit opt-out, and continues hardware work if the viewer cannot start. Later operations update the handoff without reopening the panel.

You can also ask the skill to open it:

```text
$flitrealize Open View State for the project at <PROJECT_ROOT>.
```

Or run this from the repository or extracted skill root, replacing `<PROJECT_ROOT>` with your project's absolute path:

```sh
node view-state/server.mjs --project-root "<PROJECT_ROOT>"
```

Open [127.0.0.1:49700](http://127.0.0.1:49700). The compact panel provides stage navigation, project switching, English/Chinese labels, manual refresh, and refresh every five seconds while visible. Open a summary's source to read the full handoff at the matching heading.

The skill writes `ViewState:` paragraphs; the panel displays them. Missing summaries and unavailable engineering status remain explicit. A connected bridge is a connection observation, not proof that a design passed verification. View State reads project files without modifying them.

For JSON output:

```sh
node view-state/cli.mjs --project-root "<PROJECT_ROOT>"
```

See the [View State guide](view-state/README.md) for startup steps, ports, and data conventions.

## Current PCB color workflow

Define each existing net class's full membership and signal `kind`, or an explicit `#RRGGBB` color. Fixed kinds cover power, ground, logic supply, I2C, SPI, UART, and control signals. The same kind uses the same color across projects.

`pcb-routing-plan` can check the supplied PCB net inventory and generate a color request. `pcb-edit` runs color planning and application, including rule preservation, readback, and saving. The color action does not infer signal purposes or create/reclassify nets. Old color fingerprint plans and separate verify/save requests must be replaced with a fresh plan.

See [PCB tools and color inputs](references/providers/easyeda-pro/3.4-pcb-layout-routing-tools.md) for exact contracts and capability limits.

## Develop and verify

Chinese `SKILL.md`, `references/`, and `development/` are the maintained execution source. This English overview introduces the project. `docs/en-backup/` is a fixed historical snapshot; `docs/zh-CN/` preserves legacy links.

```text
flitrealize/
├── SKILL.md           Skill entry and stage routing
├── references/        Stage, provider, and domain guidance
├── adapters/          EasyEDA Pro bridge channel
├── schemas/           Portable schematic contracts
├── scripts/           Actions, handoff tools, validation, packaging
├── view-state/        Local viewer, reader, CLI, and tests
├── tests/             Action and release regressions
├── development/       Contributor and action-system notes
└── docs/              First-run guide and historical documentation
```

Node.js 22+ runs the tools and viewer; Python 3.10+ is also needed for repository validation and packaging. From a source checkout:

```sh
python scripts/validate.py
npm test
python -m unittest discover -s tests -p "test_*.py"
```

`npm test` runs the skill and View State suites together. For the full PowerShell release check, including deterministic packaging and tests against a clean extracted ZIP:

```powershell
./scripts/release.ps1 -DryRun
```

Runtime ZIPs include the viewer and static assets, but exclude tests, historical English backups, local project records, downloaded installers, and `node_modules`. Publishing is separate from these checks.

## License

[MIT](LICENSE) · Copyright (c) 2026 FlitFancy.
