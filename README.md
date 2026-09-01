# FlitRealize

[简体中文](README.zh-CN.md)

FlitRealize is a Skill for complete hardware projects, carrying an idea forward into a testable physical prototype.

Each project uses one `CURRENT_HANDOFF.md` as its human-readable project manuscript, keeping requirements, parts, schematic, PCB, manufacturing, and prototype results on one continuous project line. The Contract, EDA source, and manufacturing artifacts continue to own their corresponding machine facts.

> Current public test release: **FlitRealize T1 `v1.0.0-test.3`**. It remains a prerelease intended for real use and continued iteration.

## What it does

```text
Idea and requirements
    -> architecture, interfaces, and part intent
    -> part resolution and confirmation
    -> schematic design
    -> EDA schematic
    -> PCB constraints, placement, and routing
    -> manufacturing files and ordering
    -> prototype bring-up and testing
    -> revision
```

FlitRealize understands the complete workflow, but each task advances only the stage the user requests.

It is designed for:

- new hardware projects that begin with requirements and architecture;
- existing projects that need continued schematic, PCB, manufacturing, or prototype work;
- projects that need continuous design state across tasks;
- work that benefits from part sources, inventory, and EDA automation.

It is not for software-only work, isolated component facts, textbook questions, or one-step EDA questions that need no project context.

## Project manuscript

`CURRENT_HANDOFF.md` is updated throughout the project and includes:

- the current objective, stage, and next step;
- requirements, architecture, interfaces, and power tree;
- part choices and source status;
- schematic blocks, pin/net intent, calculations, and test points;
- PCB constraints, layout, routing, and manufacturing state;
- prototype results, revision decisions, and current open questions.

Ordinary continuation reads the current handoff at the top and the sections relevant to the task. A full project scan is needed only when taking over an older project with no manuscript, after a global change, or when an actual conflict is found.

## How it works

### Advance by default

Ordinary project work completes what the current stage needs. Gaps that do not affect the current design can become explicit prototype tests instead of expanding every task into a formal review.

### Investigate only where needed

`CURIOUS_MODE` is a local deeper check.

Use it only when an exact model, pinout, package, critical behavior, curve, temperature rise, protection function, or source conflict materially affects the current decision. Return to ordinary work once the issue is resolved or converted into a concrete test.

### AI decides; scripts repeat

AI owns requirements, architecture, circuits, key calculations, part judgment, and cross-stage organization.

Scripts handle:

- source retrieval and download;
- local caching and inventory matching;
- format conversion and deduplication;
- Contract checks;
- repetitive EDA operations.

Automation supports design judgment; it does not replace it.

## Three main stages

### 1. Design and schematic

Turn the product idea into requirements, architecture, interfaces, power relationships, part decisions, and a complete schematic design.

Before entering EDA, confirm the key facts that affect part identity, pins, ratings, connections, and protection behavior.

### 2. PCB and manufacturing preparation

Determine the board outline, interfaces, stackup, net rules, and critical placement relationships, then complete placement, routing, copper, and DRC.

For manufacturing, keep the current source, Gerber, drill, BOM, CPL, and fabricator preview aligned.

### 3. Prototype validation and revision

Inspect the hardware and unpowered rails, then apply power through a current limit. Verify the rails first, enable functionality in stages, and test the loads, power transitions, and fault behavior the product actually needs.

Use measurements to confirm the design or define the next revision.

## Parts and EDA

Part intent and schematic design are separated from the specific EDA platform.

Electrical identity, manufacturer part number, purchasing identity, source evidence, and EDA symbol/footprint binding are related but distinct facts.

EasyEDA Pro is the currently implemented EDA Provider, but it is not required to use FlitRealize. Without EasyEDA, a project can still complete requirements, architecture, part selection, calculations, and the schematic Contract.

## Getting started

Use `$skill-installer` to install from the GitHub repository, or place the repository at:

```text
$HOME/.agents/skills/flitrealize
```

Then invoke `$flitrealize`.

Start a new project:

```text
$flitrealize Start a clean design in <PROJECT_ROOT>.
For now, complete only requirements, architecture, and part candidates. Do not write into EDA before my review.
```

Continue an existing project:

```text
$flitrealize Continue the hardware project at <PROJECT_ROOT>.
Read CURRENT_HANDOFF.md, then complete the design work I request in this task.
```

Handle one stage:

```text
$flitrealize Review the current schematic. Address only issues that change connections, ratings, protection behavior, or prototype results.
```

Placing an order, paying, reserving inventory, or making another new external commitment requires authorization for that action.

## Repository layout

```text
flitrealize/
|-- SKILL.md            # Runtime entry and full-workflow routing
|-- references/         # Stage and Provider detail loaded on demand
|-- development/        # Action and Provider development notes
|-- schemas/            # Portable machine Contracts
|-- scripts/            # Actions, part tools, validation, and packaging
|   |-- actions/
|   `-- parts/
|-- tests/
`-- docs/zh-CN/         # Chinese review mirror
```

When developing or changing the repository, run:

```powershell
python scripts/validate.py
npm test
./scripts/release.ps1 -DryRun
```

The release flow produces reproducible ZIP and SHA-256 artifacts. After English runtime instructions change, synchronize the Chinese mirror and refresh its source hashes.

## License

FlitRealize is released under the [MIT License](LICENSE). Copyright (c) 2026 FlitFancy.
