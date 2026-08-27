---
name: flitrealize
description: Advance stateful electronics hardware projects through requirements, schematic, PCB, prototype ordering, bring-up, and revision with project isolation and evidence-based decisions. Use for project-level EDA work or cross-chat continuation; do not use for software-only work, isolated component facts, textbook questions, or one-step EDA guidance that needs no project state.
---

# FlitRealize

## Objective

Advance the current hardware decision with the lightest reliable process. Default
to a testable personal prototype, keep facts inside the correct project, and let
measured evidence drive later revisions.

## Choose project, intent, and evidence

### Project and writable scope

- **NEW_PROJECT:** only when the user explicitly requests a new or independent
  project. Do not inherit another project's state.
- **EXISTING_PROJECT:** continue, revise, review, debug, or manufacture an
  identified project or artifact. Resolve its exact root, then read
  `CURRENT_HANDOFF.md`; read `BATTLE_LOG.md` next only when it describes an
  active subsystem fault.
- Ask one narrow identity/root question only when ambiguity would change the
  write destination or protected baseline.

Research, skill/catalog maintenance, read-only capture, project edits, and live
EDA mutation are separate scopes. Analysis stays read-only unless the user asks
for a change.

For an ordinary requested edit inside a resolved project root, give a compact
scope note and proceed. Use the full lock below for a new root, bulk migration,
delete/move, reviewed baseline or manufacturing output, or live EDA write:

```text
PROJECT_ROOT: <exact root>
ROUTE: NEW_PROJECT | EXISTING_PROJECT
WRITABLE_SCOPE: <exact subtree>
PROTECTED: <baseline or sibling roots>
RECOVERY_AND_CHECK: <checkpoint and success test>
```

For live EDA also name the exact document, intended delta, and affected-object
bound. Consequential external actions such as ordering, paying, or overwriting a
reviewed baseline require confirmation for that action. Detailed initialization
and manufacturing identity live in
[production-handoff.md](references/production-handoff.md).

### Task intent

- **FAST_PROTOTYPE:** default for personal and one-off boards. Block likely
  functional, safety, or manufacturing failure; record bounded gaps as
  assumptions or arrival tests.
- **ENGINEERING_REVIEW:** inspect the named artifact or question and report
  evidence, uncertainty, and the smallest useful next step.
- **PRODUCTION_RELEASE:** only for an explicit batch, PCBA, reproducibility, or
  formal release. Physical prototype evidence is required before readiness.

For mains, batteries/charging, high voltage or power, medical, regulatory, or
other safety-critical work, verify current applicable standards and obtain the
needed specialist review; this general skill alone is not release evidence.

### Evidence state

Use **OPEN** for missing/conflicting evidence, **CONDITIONAL** when prototype
progress is safe with a bounded consequence and revisit test, and **PASSED** only
when the required evidence matches the active revision. Qualifiers prove
different facts: `automated-green`, `visual-accepted`,
`manufacturing-checked`, and `physical-verified` do not imply one another.

Load [stage-gates.md](references/stage-gates.md) only when detailed lifecycle
tracking or formal production improves the decision.

## Advance through three prototype checkpoints

### 1. Schematic correctness

Check requirements, interfaces, power, safe defaults, primary circuits, pins,
ratings, values, footprints, substitutions, test method, and retained ERC
exceptions. Unfamiliar or consequential combined paths need focused evidence or
a conditional gate. Read
[schematic-contract.md](references/schematic-contract.md), adding
[audio-systems.md](references/audio-systems.md) for audio paths.

Create a derived human overview such as `ALL_VIEW.md` only when project
complexity, manual EDA collaboration, or the user benefits from it; keep the
machine-readable contract authoritative.

### 2. Prototype order check

Match the saved source revision to its export. Verify critical footprints and
orientation, connectivity, outline, holes, clearances, pours, configured DRC,
Gerber/drill contents, and the manufacturer's preview. Use a toy-board export
only when a new or uncertain generator/template/fabricator path creates material
manufacturing risk.

Before routing, choose the copper-layer count and ordered layer roles from the
design's return paths, routing density, isolation, power/thermal needs,
manufacturing capability, and cost; never force a fixed layer count by habit.
Record that decision with net classes, critical topology, and the ordered
routing plan in the current contract or chosen human overview. Close grounding
in three design-backed stages: establish realized reference copper, close
necessary local/transition returns, then optionally optimize global stitching
after routing is stable. Read
[pcb-review.md](references/pcb-review.md), adding
[easyeda-pro.md](references/easyeda-pro.md) for EasyEDA automation or exports.

### 3. Physical bring-up

Inspect first, measure unpowered rail resistance, power with a conservative
current limit, verify rails before loads, then enable blocks incrementally. Test
the real load, credible faults, power cycles, and logging to the duration and
coverage justified by the prototype's risk and acceptance goal. Read
[prototype-validation.md](references/prototype-validation.md).

## Execution invariants

- Current explicit user instruction owns objective, scope, and authorization.
  Project contracts, primary datasheets, current platform documentation, and
  manufacturer constraints own technical facts.
- Confirm only ambiguities that change architecture, safety, manufacturing,
  irreversible edits, project identity, or the definition of done.
- Protect accepted manual EDA work and reviewed baselines. Broad changes need a
  current capture; a conflicting generated apply script becomes stale after a
  manual pin, footprint, placement, routing, outline, or keepout change.
- Validate one representative object before scaling unfamiliar or repeated UI/API
  work. Prefer data-driven automation when repetition justifies it.
- Use new evidence after failure. For an actively changing subsystem with
  repeated focused experiments, read
  [debug-loop.md](references/debug-loop.md); do not create a battle log for
  ordinary implementation or a completed task.

If the host explicitly provides a workspace-local hardware-knowledge catalog or
user-preference file, query it only when relevant and within readable scope. Its
absence must not block the core workflow; never assume an author-specific path.
Single-project methods remain candidates until a materially different project
supplies realistic supporting evidence; knowledge-layer promotion also needs
writable scope there.

## Preserve current state

One `CURRENT_HANDOFF.md` per project root owns stable identity, revision,
decisions, verified facts, risks, authoritative artifacts, and the primary next
action. Keep it current rather than historical. `BATTLE_LOG.md` is optional and
temporary: it covers one active unstable subsystem, is read after the handoff,
and is archived or removed after its stable conclusion is merged back.

Read [continuation.md](references/continuation.md) when resuming or updating
state. A stale or unsafe finding applies immediately even when persistence was
not authorized; in that case do not execute the artifact and report that the
warning is not yet durable.

## Load only relevant detail

- Schematic and parts: [schematic-contract.md](references/schematic-contract.md)
- PCB and manufacturing artwork: [pcb-review.md](references/pcb-review.md)
- EasyEDA Pro automation: [easyeda-pro.md](references/easyeda-pro.md)
- Reusable local Actions and EDA-provider boundaries:
  [local-actions.md](references/local-actions.md)
- Active repeated debugging: [debug-loop.md](references/debug-loop.md)
- Audio paths: [audio-systems.md](references/audio-systems.md)
- Bring-up: [prototype-validation.md](references/prototype-validation.md)
- Resume and state ownership: [continuation.md](references/continuation.md)
- Initialization, procurement, and manufacturing package:
  [production-handoff.md](references/production-handoff.md)
- Detailed lifecycle/formal release: [stage-gates.md](references/stage-gates.md)

Stop loading when the current decision is supported.

## Report the decision

Lead with the decision, then blockers, accepted risks, uncertainty, evidence
state, and the smallest useful next action or test. Never call a board
production-ready from appearance, theoretical review, ERC/DRC, or manufacturing
files alone.
