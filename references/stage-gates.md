# Hardware lifecycle gates

Use this detailed model only when lifecycle tracking, exact evidence qualifiers,
or formal production improves the current decision.

## Separate three axes

- **Project route:** NEW_PROJECT or EXISTING_PROJECT.
- **Task intent:** FAST_PROTOTYPE, ENGINEERING_REVIEW, or PRODUCTION_RELEASE.
- **Evidence phase:** how far the active revision has actually progressed.

For ordinary prototypes, the three checkpoints in `SKILL.md` are enough:

| Prototype checkpoint | Detailed phases |
| --- | --- |
| Schematic correctness | 0 problem, 1 architecture, 2 schematic contract |
| Prototype order check | 3 footprints, 4 placement, 5 routing, 6 package |
| Physical bring-up | 7 bring-up/EVT |
| Separate productization path | 8 revision/productization |

Do not require both representations as duplicate project processes.

## Gate state and evidence qualifiers

- **OPEN:** required evidence is absent, stale, or conflicting.
- **CONDITIONAL:** prototype progress has a bounded missing proof, consequence,
  owner, and exact revisit/arrival-test trigger.
- **PASSED:** evidence required for the gate exists, agrees with the active
  revision, and has been reviewed at the necessary level.

Evidence qualifiers are independent:

- `automated-green`: configured tests/capture/ERC/DRC passed;
- `visual-accepted`: real placement/orientation/access/layout intent was accepted;
- `manufacturing-checked`: matching outputs and current manufacturer preview/DFM
  were cross-checked;
- `physical-verified`: measured prototypes meet defined criteria.

FAST_PROTOTYPE may advance conditionally when safe, but neither assumptions nor a
lower qualifier may be renamed as a passed engineering/production gate.

## Phase decisions

| Phase | Decision supported by its evidence | Gate question |
| --- | --- | --- |
| 0 Problem boundary | purpose, environment, host/power/enclosure, cost and exclusions | Is the product boundary agreed? |
| 1 Architecture | blocks, power tree, stable interfaces, faults, test intent and major supply risk | Does every requirement map to a testable block/interface? |
| 2 Schematic contract | exact circuit, ratings, parts/footprints, pin/net intent, ERC and BOM draft | Is connectivity and component intent internally consistent? |
| 3 Footprints/constraints | land patterns, pin 1, outline/holes, mating and physical keepouts | Are critical physical interfaces proven? |
| 4 Placement | zoning, loops, decoupling, mechanical/assembly access and collision evidence | Is placement defensible before routing? |
| 5 Routing/planes | net classes, critical topology, returns, planes, vias and configured DRC | Is geometry legal and electrically defensible? |
| 6 Manufacturing candidate | matched source/output, BOM/CPL as needed, preview and manifest | Is one reproducible prototype candidate ready to manufacture? |
| 7 Bring-up/EVT | safe power-on, rail/interface/load/fault tests and useful logs | Do measured prototypes meet defined functional criteria? |
| 8 Productization | evidence-linked revision, production test, calibration, enclosure/compliance and traceability | Is applicable product evidence complete? |

Phase 6 can authorize a prototype build; it does not establish production
readiness. Formal readiness requires physical evidence and the applicable Phase 8
work, including current standards and specialist review for regulated/high-risk
domains.

## Record only decision-relevant evidence

For an active gate, record revision/time, input artifacts, checks/tool versions,
useful numeric results, blockers, accepted risks, owner/revisit trigger, and next
action. Avoid lifecycle paperwork that does not change a decision.

When inheriting a project, read current state, inspect named source/export
identity, run configured targeted status checks, and compare gate claims with
artifacts. Downgrade stale or unsupported claims; filenames alone do not prove a
phase passed.

Classify findings as:

- **Blocker:** likely wrong function, safety issue, bad manufacturing output, or
  missing artifact required for the requested decision.
- **Accepted prototype risk:** bounded limitation with a planned test/revisit.
- **Future improvement:** useful change without evidence that the current build
  must wait.
