# FlitRealize

**Carry a hardware idea to a tested prototype, keeping design decisions, evidence, and the next step together.**

[简体中文](README.zh-CN.md) · [First run](docs/first-run.md) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/flitfancy/flitrealize/releases)

Version marker: `v2.0.0`.

One skill covers requirements, parts, schematics, PCB work, manufacturing preparation, and prototype validation. The agent makes engineering judgments; scripts perform repeatable computation, execution, and readback. Each project keeps one `CURRENT_HANDOFF.md`; contracts, EDA files, and original evidence own their respective facts.

## Available work

| Task | Capability and scope |
| --- | --- |
| Requirements and parts | Functional, power, and interface architecture; part identity and datasheets; existing project inventory tools |
| Schematics | Contract checks, library bindings, batch placement, endpoint connections, reflow, saving, and checks |
| Placement | Unified inputs and public model; multiple starts, CP-SAT, open blocks, rigid copper templates, finite-shape gravity packing, and local comparisons |
| Routing | Role rules and FR batch solving, acceptance, and native execution; two-layer A* pre-routing, multilayer via-space scans, joint fanout, copper paths, bounded repair, and cleanup |
| PCB operations | Board/layer/keepout tools, explicit moves, selected trace widths, net colors, and grounding |
| Manufacturing and prototypes | Engineering guidance and evidence organization for matched manufacturing candidates, BOM/CPL, measurements, and revisions |
| Continuity | A short handoff, relevant project chapters, and the read-only View State panel |

Candidates and local diagnostics retain their scope; ground-space analysis models potential capacity. Complete candidates use the existing native execution chain. Local blocks, preserved-copper packing, and fine-layout candidates still need complete native plans. Return paths, current capacity, thermal behavior, and manufacturing conclusions use their corresponding engineering checks.

EasyEDA Pro is the implemented live provider: desktop sessions can use the official CLI; web sessions and desktop Bridge sessions use API Gateway and a local Node Bridge. The same `eda-host.mjs` selects the channel. CLI read-only APIs, sessions, and original-request queries have been exercised; other native operations follow their documented representative checks. Other EDA software needs its own provider.

## Start or continue

Install in the host's skill directory, with `SKILL.md` directly inside `flitrealize/`, then open a new task:

```text
$flitrealize Start a hardware project in <PROJECT_ROOT>; develop requirements, architecture, and part candidates.
$flitrealize Continue <PROJECT_ROOT> and work on its current PCB placement issues.
```

Daily work reads the project handoff, relevant chapters, and the current operation guide. Use the [stage map](references/0.0-overview.md) for stage transitions or overall design. [The main entry](SKILL.md#查找能力) explains discovery; [first run](docs/first-run.md) covers dependencies and channels. Keep the project directory separate from the skill.

[View State](view-state/README.md) opens when starting or first taking over a project, unless declined, and is reused afterward. It displays authored project content and channel health without inferring engineering progress.

## Architecture

| Part | Responsibility |
| --- | --- |
| `SKILL.md` | Task scope, continuity, discovery, and necessary principles |
| `references/` | Engineering stages, public inputs/algorithms, and operation boundaries |
| `references/0.3-easyeda-pro.md` | Shared target, save/readback, and unknown-result recovery rules |
| CLI / manifest | Discover capabilities, receive inputs, connect implementations, and preserve evidence |
| Public model and algorithms | Derive candidates with shared constraints and acceptance |
| Providers / channels | Convert native identities, layers, and netlists and perform native operations; the existing host selects official CLI or Bridge |

Public algorithms live in `scripts/pcb-layout/` and `scripts/pcb-routing/`; native implementations and the CLI channel live in `scripts/providers/`, with Bridge in `adapters/`. Project settings and evidence stay in the project. There is one maintained Chinese execution source; `docs/zh-CN` contains compatibility redirects and `docs/en-backup` is a fixed historical snapshot.

## Develop and verify

Use Node.js 22+. Repository validation and packaging scripts support Python 3.10+; numerical backends require Python 3.12+ and [pinned dependencies](requirements-pcb.txt). Configure them through [first run](docs/first-run.md#数值与路由环境). In a source checkout:

```sh
python scripts/validate.py
npm test
python -m unittest discover -s tests -p "test_*.py"
```

Numerical tests need the configured interpreter; Bridge integration tests need its channel dependencies. `./scripts/release.ps1 -DryRun` performs release checks. Runtime packages include tools, references, the dependency manifest, and the panel; tests, project records, and `node_modules` are excluded. See [Action and provider development](development/action-system.md).

[MIT](LICENSE) · Copyright (c) 2026 FlitFancy.
