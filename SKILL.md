---
name: flitrealize
description: Advance stateful electronics hardware projects from ideas, requirements, and part selection through schematic, PCB, manufacturing files, bring-up, and revision. Use for project-level EDA work or cross-task continuation; do not use for software-only work, isolated component facts, textbook questions, or one-step EDA guidance that needs no project state.
---

# FlitRealize

## Goal

Complete the hardware work the user currently asks for, and keep the project moving from an idea toward a testable physical prototype.

The workflow covers a full project, but each task advances only the requested stage. Do not expand later stages or create their files before they are needed.

## Project and permissions

- **NEW_PROJECT:** Use only when the user explicitly asks for a new or independent project. Do not inherit design choices, parts, calculations, or EDA state from another project.
- **EXISTING_PROJECT:** Continue an identified project. Read `CURRENT_HANDOFF.md` only when the task depends on earlier project decisions. Use `DEBUG_NOTES.md` only for an active fault that still needs repeated experiments.

The user's current request defines the goal, scope, and authorization.

Make changes within the current task directly, including EDA writes the user has already authorized. Ask only when the write target cannot be identified uniquely or an actual conflict cannot be merged safely.

Ordering, payment, inventory reservation, or any other new external commitment requires explicit authorization for that action.

Initialize only the structure needed by the current task. Read [4.1 Manufacturing files and prototype ordering](references/4.1-production-handoff.md) when preparing manufacturing files or a prototype order.

## Full workflow

```text
Idea and requirements
    → architecture, interfaces, and part intent
    → part resolution and confirmation
    → schematic design
    → EDA schematic
    → PCB constraints, placement, and routing
    → manufacturing files and ordering
    → prototype bring-up and testing
    → revision
```

When the user asks for only one part of this flow, complete that part and stop.

Part selection and schematic intent remain independent of a specific EDA platform. EasyEDA, KiCad, and other EDA tools are later Providers. Missing bindings for one platform must not block portable design or part confirmation.

## Working mode

Proceed in **DEFAULT_MODE** unless one specific decision needs deeper investigation.

Enter **CURIOUS_MODE** only for the affected item when:

- the exact model, suffix, pinout, package, or a critical parameter lacks reliable support or conflicts across sources;
- the decision depends on curves, transients, temperature rise, derating, or mechanical timing that a normal parameter table cannot answer;
- ordinary sources and calculations still cannot show whether a stated core requirement is met;
- the part explicitly provides protection, isolation, or fault shutdown in the architecture;
- the user asks for deeper verification.

In CURIOUS_MODE, read the current manufacturer material for the exact part and inspect only the worst cases, pin mapping, default states, and fault behavior relevant to the question. Treat reliable manufacturer and authorized-distributor material as usable by default; add source comparison only when evidence is missing or contradictory.

Return to DEFAULT_MODE once the question is resolved or converted into a clear prototype test. CURIOUS_MODE stays local to the affected question and does not create extra reports, states, or files by itself.

## Three main stages

### 1. Design and schematic

Clarify requirements, architecture, interfaces, power relationships, and part intent. Then confirm the parts and schematic details needed by the current design.

Gaps that do not affect architecture, part choice, or connectivity may become prototype tests. Before writing the finished schematic into EDA, confirm the evidence that affects part identity, pins, ratings, and protection behavior.

### 2. PCB and manufacturing preparation

When PCB work is requested, establish the outline, interface locations, stackup, net rules, and important placement constraints, then complete placement, routing, copper, and DRC.

When manufacturing or ordering is requested, pair the current saved source with its Gerber, drill, BOM, CPL, and board-house preview as applicable.

### 3. Prototype validation and revision

When hardware is available, inspect the assembly and unpowered rails before applying power through a conservative current limit. Verify power rails first, then enable functional blocks and test the loads, power cycles, and fault behavior the product actually needs.

Use measured results to accept the current design or define the next revision.

## Tools and EDA entry

Before repeated work or EDA writes, check whether the Skill already provides a suitable script, Action, or Provider. Reuse it when it fits. When repetition clearly benefits from automation, validate one representative object before scaling.

Keep requirements, architecture, part selection, and the schematic Contract portable. Select an EDA Provider only when the task needs an EDA file to be created or changed:

- Use the Provider the user already specified.
- Continue with the Provider of an existing authoritative EDA source unless the user requests migration.
- If no EDA has been selected, finish the portable design first and choose only when EDA work begins.
- If the selected EDA has no working Provider, preserve the portable artifacts and describe the manual remainder. Do not create placeholder support.

After selecting a Provider, read only its entrypoint and the operation needed by the current stage.

Currently implemented:

- EasyEDA Pro: [EasyEDA Pro Provider](references/0.3-easyeda-pro.md)

When one Provider operation fails for a clear reason, correct it and continue. Only when the same problem needs repeated observation or experiments should that problem enter CURIOUS_MODE and use [0.2 Repeated-failure debugging](references/0.2-debug-loop.md).

## Global notes

- Project artifacts, exact datasheets, and current platform documentation own technical facts.
- Other projects may provide ideas, but the current project's parts, calculations, and connections must be confirmed against its own requirements and evidence.
- AI owns requirements, architecture, circuit decisions, key calculations, and final part judgment. Scripts own retrieval, download, caching, inventory matching, format conversion, deduplication, and repeated EDA operations.
- Electrical identity, purchasing identity, source evidence, and EDA binding are separate facts and do not replace one another.
- Use the script, Action, or Provider already supplied for the current stage before creating a one-off implementation.
- Validate one representative object before scaling an unfamiliar or repeated operation.
- Do not create state, reports, or project files for a stage the project has not entered.
- When the user requests regulatory, compliance, or formal release conclusions, check the current applicable standards and required professional evidence. This Skill is not release evidence by itself.

## Save project state

Create or update `CURRENT_HANDOFF.md` at the project root only when the project must continue across tasks or conversations.

It stores only the currently valid project identity, major decisions, confirmed facts, important open items, authoritative files, and next step. It is not a full history.

Read [0.1 Continue an existing project](references/0.1-continuation.md) when resuming work.

Use `DEBUG_NOTES.md` and read [0.2 Repeated-failure debugging](references/0.2-debug-loop.md) only when one active fault needs multiple experiments. Merge a stable result back into the current project state.

## Load details by stage

Read only what the current task needs. The numbered map is in [0.0 Reference map](references/0.0-overview.md).

- Requirements, functional blocks, interfaces, and power architecture:
  [1.1 Requirements and architecture](references/1.1-requirements-and-architecture.md)
- Part intent, inventory matching, and source retrieval:
  [1.2 Parts and source material](references/1.2-parts.md)
- Schematic design and the machine-readable Contract:
  [2.1 Schematic design and Contract](references/2.1-schematic-contract.md)
- EasyEDA Pro Provider:
  [0.3 EasyEDA Pro Provider](references/0.3-easyeda-pro.md)
- PCB design, placement, routing, and checks:
  [3.1 PCB design and review](references/3.1-pcb-review.md)
- Audio design:
  [1.3 Audio hardware design](references/1.3-audio-systems.md)
- Prototype bring-up and validation:
  [5.1 Prototype bring-up, testing, and revision](references/5.1-prototype-validation.md)
- Active repeated debugging:
  [0.2 Repeated-failure debugging](references/0.2-debug-loop.md)
- Cross-task continuation:
  [0.1 Continue an existing project](references/0.1-continuation.md)
- Manufacturing files and prototype ordering:
  [4.1 Manufacturing files and prototype ordering](references/4.1-production-handoff.md)
- Productization and formal release:
  [6.1 Productization and formal release](references/6.1-production-release.md)

Stop loading references once the current task has enough support to continue or finish.
