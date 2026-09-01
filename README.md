# FlitRealize

[简体中文](README.zh-CN.md)

FlitRealize is a hardware-project skill for turning an idea into testable
electronics. It keeps requirements, part decisions, schematic intent, PCB work,
prototype results, and revisions connected without forcing every project through
the entire process at once.

> Current public test build: **FlitRealize T1 `v1.0.0-test.2`**. It is still a
> prerelease and is intended for practical testing and iteration.

## What it does

```text
Idea and requirements
    -> architecture, interfaces, and part intent
    -> part resolution and confirmation
    -> schematic design
    -> EDA schematic
    -> PCB constraints, placement, and routing
    -> manufacturing files and ordering
    -> prototype bring-up and test
    -> revision
```

FlitRealize understands the whole flow but works only on the stage the user
currently requested. A request for architecture does not automatically create
EDA files, and a schematic review does not automatically become a production
release process.

It is designed for:

- new hardware projects that need requirements, architecture, and part choices;
- existing projects that need schematic, PCB, manufacturing, or bring-up work;
- work that continues across tasks without mixing project state;
- EDA automation where repeatable operations benefit from tested Actions.

It is not intended for software-only work, isolated component facts, textbook
questions, or a one-step EDA question that does not need project context.

## How it works

### Direct by default

For ordinary project work, FlitRealize advances the requested stage directly.
It uses reliable manufacturer or official distributor information when part
facts are needed, and turns non-critical unknowns into explicit prototype tests
instead of expanding every task into a formal review.

### Curious only where it matters

`CURIOUS_MODE` is a temporary local deep check, not a project-wide mode. It is
used only when an exact part identity, pinout, package, critical behavior, curve,
thermal limit, protection function, or conflicting source needs closer review.
Once that question is answered or converted into a concrete test, normal work
continues.

### AI decides; scripts repeat

The AI owns requirements, architecture, circuit decisions, calculations, and
final part judgment. Scripts handle repeatable work such as searching,
downloading, caching, inventory matching, format conversion, and EDA actions.
Automation supports the design process; it does not replace engineering
judgment.

## Three working stages

### 1. Design and schematic

Turn product intent into requirements, architecture, interfaces, power
relationships, structured part intent, resolved parts, and a complete schematic
design. Before entering EDA, confirm the exact facts that affect identity,
pinout, ratings, connectivity, or protection behavior.

### 2. PCB and manufacturing preparation

Establish the board outline, interface locations, stackup, rules, and critical
placement constraints before placement, routing, copper, and configured DRC.
When preparing an order, keep the saved source, Gerber, drill, BOM/CPL, and
fabricator preview aligned.

### 3. Prototype validation and revision

Inspect the assembled board and unpowered rails, use current-limited power-up,
verify rails before functional blocks, and test the loads, power cycles, and
fault behavior that matter to the product. Measurements drive the next
revision.

## Parts and EDA stay separate

Part intent and schematic design are portable. Electrical identity,
manufacturer part number, procurement identity, source evidence, and EDA
symbol/footprint binding are related but separate facts.

EasyEDA Pro is the currently implemented EDA Provider, not a prerequisite for
using FlitRealize. A project can complete requirements, architecture, part
selection, calculations, and schematic intent without EasyEDA. Provider-specific
references and Actions are loaded only when that EDA stage is requested.

## Project continuity

For a new project, FlitRealize starts from that project's own requirements and
does not inherit another project's parts, calculations, or EDA state. Existing
projects can use one `CURRENT_HANDOFF.md` when work must continue across tasks or
conversations. Ordinary single-task work does not need extra state files.

## Start using it

Install from the GitHub repository with `$skill-installer`, or place the
repository at:

```text
$HOME/.agents/skills/flitrealize
```

Then invoke it explicitly with `$flitrealize`. Codex may also select it
automatically for a matching project-level hardware request.

Start a new project:

```text
$flitrealize Start a clean hardware project at <PROJECT_ROOT>.
For now, complete only the requirements, architecture, and part candidates.
Do not write to EDA until I review them.
```

Continue an existing project:

```text
$flitrealize Continue the hardware project at <PROJECT_ROOT>.
Read its current handoff if earlier decisions are needed, then complete the
next requested design task.
```

Ask for a focused stage:

```text
$flitrealize Review the current schematic and list only issues that can change
connectivity, ratings, protection behavior, or prototype success.
```

Ordering, payment, stock reservation, and other new external commitments still
require explicit authorization for that action.

## Repository

```text
flitrealize/
├── SKILL.md            # Runtime entrypoint and whole-flow routing
├── references/         # Stage and Provider details loaded on demand
├── development/        # Maintainer-only Action and Provider notes
├── schemas/            # Portable machine-readable hardware contracts
├── scripts/            # Actions, part tools, validation, and packaging
│   ├── actions/        # Registered host and EDA Actions
│   └── parts/          # Part source resolver
├── tests/              # Action and release regressions
└── docs/zh-CN/         # Chinese review mirrors
```

For repository development:

```powershell
python scripts/validate.py
npm test
./scripts/release.ps1 -DryRun
```

The release workflow builds a deterministic ZIP and SHA-256 sidecar. When an
English runtime instruction changes, update its Chinese mirror and refresh the
source hashes with `python scripts/update_translation_hashes.py`.

## License

FlitRealize is released under the [MIT License](LICENSE). Copyright (c) 2026
FlitFancy.
