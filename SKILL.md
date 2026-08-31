---
name: flitrealize
description: Advance stateful electronics hardware projects from ideas and requirements through part selection, schematic, PCB, manufacturing files, bring-up, and revision. Use for project-level EDA work or cross-chat continuation; do not use for software-only work, isolated component facts, textbook questions, or one-step EDA guidance that needs no project state.
---

# FlitRealize

## Objective

Complete the hardware work the user currently requested and keep a clear path
from idea to testable hardware.

Cover the whole project flow, but advance only the requested stage. Do not open
later stages or create their files and process unless the user asks for them.

## Project and authorization

- **NEW_PROJECT:** use only when the user explicitly requests a new or
  independent project. Do not inherit another project's design, parts,
  calculations, or EDA state.
- **EXISTING_PROJECT:** continue an identified project. Read
  `CURRENT_HANDOFF.md` only when the current task depends on earlier project
  decisions. Read `BATTLE_LOG.md` only for an active fault still under repeated
  experiment.

The current user request owns the objective, scope, and authorization.

Perform in-scope changes directly, including authorized EDA writes. Ask only
when the write target cannot be determined uniquely or an actual conflict
cannot be merged safely.

Ordering, paying, reserving stock, or another new external commitment requires
authorization for that action.

Read [production-handoff.md](references/production-handoff.md) when initializing
a project or preparing procurement or manufacturing delivery.

## Whole flow

```text
Idea and requirements
    -> architecture, interfaces, and part intent
    -> part resolution and approval
    -> schematic design
    -> EDA schematic
    -> PCB constraints, placement, and routing
    -> manufacturing files and ordering
    -> prototype bring-up and test
    -> revision
```

Stop when the user's current deliverable is complete.

Part selection and schematic intent remain portable. EasyEDA, KiCad, and other
EDA systems are later Providers; a missing Provider binding must not block
portable design or part decisions.

## Working style

Normally, continue the current stage directly.

Enter **CURIOUS_MODE** only for the affected question when:

- exact MPN, suffix, pinout, package, or a critical parameter lacks reliable
  support or sources conflict;
- the decision depends on curves, transients, temperature rise, derating, or
  mechanical timing that a normal parameter table does not answer;
- available sources and ordinary calculations still cannot decide a stated core
  requirement;
- the requirements or architecture explicitly assign protection, isolation, or
  fault-shutdown responsibility to the part; or
- the user explicitly requests deeper verification.

In CURIOUS_MODE, read the current manufacturer material for the exact part and
check only the relevant worst case, pin mapping, default state, and fault
behavior. A reliable manufacturer or official distributor source is sufficient
by default; add sources only to resolve missing or conflicting information.

Leave CURIOUS_MODE when the question is resolved or converted into a specific
prototype test, then continue the current stage. Do not expand it into a whole
project review or create extra reports, states, or files.

## Three main stages

### 1. Design and schematic

Organize requirements, architecture, interfaces, power relationships, and part
intent. Resolve the parts needed for the current decision, then complete the
schematic design.

Gaps that cannot change architecture, part selection, or connectivity may become
prototype tests. After the schematic design and before EDA entry, confirm facts
that affect exact part identity, pinout, ratings, or protection behavior.

### 2. PCB and manufacturing preparation

When the user requests a PCB, establish outline, interface locations, stackup,
net rules, and critical placement constraints before placement, routing, copper,
and configured DRC.

When preparing an order, match the saved source with Gerber, drill, required
BOM/CPL, and the fabricator preview.

### 3. Prototype validation and revision

Inspect the hardware and unpowered rails before current-limited power-up. Verify
rails first, then enable functional blocks and test the loads, power cycles, and
fault behavior that matter to the product.

Use measurements to confirm the current design or define the next revision.

## Shared rules

- Project records, exact datasheets, and current platform documentation own
  technical facts.
- Other projects are examples only. Re-establish current parts, calculations,
  and connectivity from this project's requirements or sources.
- AI owns requirements, architecture, circuit decisions, critical calculations,
  and final part judgment. Scripts own search, download, caching, inventory
  matching, format conversion, deduplication, and repeated EDA work.
- Keep electrical identity, procurement identity, source evidence, and EDA
  binding separate; none substitutes for another.
- When search, conversion, or repeated work is needed, query registered public
  Actions for the current domain instead of scanning the scripts directory. Use
  a one-off implementation only when no matching Action exists.
- Validate one representative object before scaling an unfamiliar repeated
  operation.
- Do not create state, reports, or project files for a stage that has not been
  requested.
- When the user requests a regulatory, compliance, or formal release claim,
  verify the applicable current standards and specialist evidence. This Skill
  is not release evidence.

## Preserve project state

Create or update one `CURRENT_HANDOFF.md` at the project root only when work must
continue across tasks or conversations. Keep current identity, decisions,
confirmed facts, important open items, authoritative files, and the next action;
do not turn it into full history.

Read [continuation.md](references/continuation.md) for continuation and state
ownership.

Use `BATTLE_LOG.md` and read [debug-loop.md](references/debug-loop.md) only when
one active fault needs repeated experiments. Merge the stable conclusion back
into current project state.

## Load detail by stage

Read only what the current task needs:

- Part intent, inventory matching, and sourcing resolution:
  [parts.md](references/parts.md)
- Schematic and machine-readable Contract:
  [schematic-contract.md](references/schematic-contract.md)
- EDA Provider selection:
  [eda-select.md](references/eda-select.md)
- PCB, routing, and manufacturing artwork:
  [pcb-review.md](references/pcb-review.md)
- Audio design:
  [audio-systems.md](references/audio-systems.md)
- Prototype bring-up and validation:
  [prototype-validation.md](references/prototype-validation.md)
- Active repeated debugging: [debug-loop.md](references/debug-loop.md)
- Cross-task continuation: [continuation.md](references/continuation.md)
- Initialization, procurement, and manufacturing delivery:
  [production-handoff.md](references/production-handoff.md)
- Full lifecycle tracking, manufacturing-candidate review, or formal release:
  [stage-gates.md](references/stage-gates.md)

Stop loading when the current task has enough support to proceed or finish.
