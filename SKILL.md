---
name: flitrealize
description: Advance stateful electronics hardware projects from ideas, requirements, and part selection through schematic, PCB, manufacturing files, prototype bring-up, and revision. Use for project-level EDA work or cross-task continuation; do not use for software-only work, isolated component facts, textbook questions, or one-step EDA guidance that needs no project state.
---

# FlitRealize

## Goal

Complete the hardware work the user currently requests and keep moving the idea toward a testable physical prototype.

The workflow covers a complete project, but each task advances only the stage the user requested. Every project uses one `CURRENT_HANDOFF.md` as its human-readable project manuscript, updated continuously across requirements, parts, schematic, PCB, manufacturing, and prototype validation.

## Project entry

- **NEW_PROJECT:** Start an independent project in the root specified by the user and create `CURRENT_HANDOFF.md` from the current requirements. Do not inherit design, part, calculation, or EDA state from another project.
- **EXISTING_PROJECT:** Continue an identified project. Read `CURRENT_HANDOFF.md` first. If it does not exist, reconstruct the first project manuscript from the current project's design, part, EDA, manufacturing, and test artifacts.

The user's current request defines the objective, scope, and authorization.

Make changes within the current task, including authorized EDA writes, directly. Ask only when the write target cannot be identified uniquely or an actual conflict cannot be merged safely.

Placing an order, paying, reserving inventory, or making another new external commitment requires authorization for that action.

## Project manuscript

`CURRENT_HANDOFF.md` provides the human-readable view of the current project, including:

- the current objective, stage, and next step;
- requirements, architecture, interfaces, and power relationships;
- part decisions and source status;
- schematic blocks, pin/net intent, key calculations, and test points;
- PCB constraints, layout, routing, and manufacturing state;
- prototype measurements, revision conclusions, and current open questions.

For an ordinary task, read the current handoff at the top and the sections relevant to the request, then read the machine artifacts that own the corresponding facts. When the current stage produces stable results, update its section and the current handoff.

The manuscript describes the current design. It does not accumulate chat transcripts, complete logs, or obsolete alternatives.

The Contract, EDA source, manufacturing outputs, and raw test records continue to own their respective machine facts. The manuscript organizes those facts into one continuous, reviewable project description.

## Full workflow

```text
Idea and requirements
    -> architecture, interfaces, and part intent
    -> part resolution and confirmation
    -> schematic design
    -> EDA schematic
    -> PCB constraints, layout, and routing
    -> manufacturing files and ordering
    -> prototype bring-up and testing
    -> revision
```

When the user requests only part of this workflow, complete that part and stop.

Part selection and schematic intent can be completed independently of a specific EDA platform. EasyEDA, KiCad, or another EDA becomes a Provider when the design enters the actual tool. Missing bindings for one platform do not prevent requirements, part work, and portable schematic design from continuing.

## Working modes

Ordinary work uses `DEFAULT_MODE` and completes the current stage directly with a concise, reliable process.

Enter **CURIOUS_MODE** only for the affected local decision when:

- the exact model, suffix, pinout, package, or critical parameter lacks reliable support or sources conflict;
- the decision depends on curves, transients, temperature rise, derating, mechanical timing, or behavior not answered directly by an ordinary parameter table;
- available sources and ordinary calculations still cannot determine whether a specific core requirement is met;
- a part explicitly owns protection, isolation, or fault shutdown in the requirements or architecture;
- the user asks for deeper verification.

In CURIOUS_MODE, read current manufacturer material for the exact part and inspect only the worst cases, pin correspondence, default state, and fault behavior relevant to the question. Reliable manufacturer and authorized-distributor sources may be used directly. Add source comparison only when information is missing or conflicting.

Return to DEFAULT_MODE when the question is resolved or converted into an explicit test. CURIOUS_MODE remains local to the affected issue and does not create extra reports or process for the rest of the project.

## Three main stages

### 1. Design and schematic

Organize product requirements, establish the functional architecture, power tree, and interface relationships, confirm the main parts, then complete the schematic design, key calculations, pin/net intent, and prototype test intent.

Ordinary gaps that do not affect architecture, part selection, or connections may remain as explicit prototype tests. Before writing into EDA, confirm the key sources that affect part identity, pins, ratings, and protection behavior.

### 2. PCB and manufacturing preparation

Use the schematic and product structure to determine the board outline, interface positions, stackup, functional partitioning, net rules, and critical topologies, then complete placement, routing, copper, and DRC.

When preparing manufacturing outputs, keep the saved source aligned with Gerber, drill, BOM, CPL, and the fabricator preview.

### 3. Prototype validation and revision

When hardware arrives, inspect the assembly and unpowered rails, then power it through a conservative current limit. Verify the rails first, enable blocks in stages, and test the loads, power transitions, and fault behavior that matter to the product.

Use measurements to confirm the current design or define the next revision. Update the manuscript section that owns each conclusion.

## Tools

AI owns requirements, architecture, circuit design, key calculations, part judgment, and cross-stage organization.

Scripts own repeatable work such as:

- source retrieval and download;
- local caching and inventory matching;
- format conversion and deduplication;
- Contract checks;
- EDA placement, connection, readback, and other repetitive operations.

Use an existing script, Action, or Provider when it fits the current stage. Before scaling a batch operation over unfamiliar objects, validate one representative object.

## Entering EDA

Requirements, architecture, part selection, and the schematic Contract remain independent of a specific EDA. Select a Provider only when the task needs to create or modify EDA files:

- use the Provider named by the user;
- continue with the Provider that owns an existing project's authoritative EDA source unless the user requests migration;
- finish the portable design first when no EDA has been selected;
- when the selected EDA has no usable Provider, preserve the completed design artifacts and state which work remains manual.

After selecting a Provider, read only its entry reference and the workflow needed for the current operation.

Currently implemented:

- EasyEDA Pro: [0.3-easyeda-pro.md](references/0.3-easyeda-pro.md)

If a failure has an understood cause, correct it and continue. Read [0.2-debug-loop.md](references/0.2-debug-loop.md) only when the same problem needs multiple rounds of observation or experiment.

## Shared principles

- Current project materials, exact datasheets, and current platform documentation own technical facts.
- Other projects may provide ideas, but parts, calculations, and connections for this project are confirmed from its current requirements and sources.
- A part's electrical identity, purchasing identity, source evidence, and EDA binding are recorded separately and do not substitute for one another.
- When the manuscript and a machine artifact disagree, read the current artifact that owns the fact and reconcile them.
- Do not expand stages the user has not requested.
- When the user asks for regulatory, compliance, or formal-release conclusions, check current applicable standards and required professional evidence. This Skill is not itself release evidence.

## Continuation and debugging

For ordinary continuation, use [0.1-continuation.md](references/0.1-continuation.md) to read and update `CURRENT_HANDOFF.md`.

Use `DEBUG_NOTES.md` and read [0.2-debug-loop.md](references/0.2-debug-loop.md) only when one active fault needs multiple experiments. When it stabilizes, update the affected manuscript section and end the debug record.

## Load stage details on demand

Read only the documents needed for the current task. The stage map is in [0.0-overview.md](references/0.0-overview.md).

- Requirements, functional blocks, interfaces, and power architecture:
  [1.1-requirements-and-architecture.md](references/1.1-requirements-and-architecture.md)
- Part intent, inventory matching, and source resolution:
  [1.2-parts.md](references/1.2-parts.md)
- Schematic design and the machine-readable Contract:
  [2.1-schematic-contract.md](references/2.1-schematic-contract.md)
- EasyEDA Pro Provider:
  [0.3-easyeda-pro.md](references/0.3-easyeda-pro.md)
- PCB design, placement, routing, and review:
  [3.1-pcb-review.md](references/3.1-pcb-review.md)
- Audio design:
  [1.3-audio-systems.md](references/1.3-audio-systems.md)
- Manufacturing files and prototype ordering:
  [4.1-production-handoff.md](references/4.1-production-handoff.md)
- Prototype bring-up and validation:
  [5.1-prototype-validation.md](references/5.1-prototype-validation.md)
- Productization and formal release:
  [6.1-production-release.md](references/6.1-production-release.md)

Stop loading references once the current task has enough support to continue or finish.
