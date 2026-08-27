# EasyEDA Pro PCB grounding workflow

Use this workflow after the PCB foundation has proven actual reference copper.
It separates necessary return closure from optional global optimization:

```text
read-only inventory
  -> necessary local/transition returns
  -> repour + DRC + readback
  -> optional global stitching
  -> final readback and drill evidence
```

More vias are not an acceptance criterion.

## Entry evidence

- exact project and PCB document identity;
- accepted layer/keepout/pour evidence from
  [pcb-foundation.md](pcb-foundation.md);
- target GND net and via geometry constraints;
- selected designators or signal transitions with an engineering rationale; and
- current routing, Region, via, and source state.

## 1. Capture a grounding inventory

Use `scripts/actions/pcb-grounding-inspect.js` as the read-only inventory Action.
It enumerates API-visible pours, Regions, vias, and components; groups pours by
net/layer; reports GND-via proximity for selected designators; and scans the
document plus footprint sources. The source scan distinguishes instantiated
keepouts from the `PROHIBITEDREGION` display token so an API query gap is not
treated as an empty board.

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-grounding-inspect.js --input-file <inspect.json>
```

Retain `inspectionFingerprint`, API/source coverage, pour networks, visible
keepout geometry, and unresolved footprint evidence with the via plan.
`detailLevel: summary` still scans every object; use `full` only for exact
primitive geometry. Manual placement, routing, pour, Region, via, or keepout
changes invalidate the fingerprint.

## 2. Close necessary returns

Use `scripts/actions/pcb-ground-vias.js` for a bounded necessary-via transaction.
`mode: generate` resolves exact designators and GND pad numbers, reads live pad
coordinates/shapes, and proposes cardinal-offset candidates. It filters
resolved board keepouts and existing/planned vias but stays blocked until board
containment and local copper/pad/track clearance have independent evidence.
Custom pad geometry without a proven fallback radius also stays blocked.

`mode: plan` accepts an exact externally selected list. Both paths require
document identity, inspection fingerprint, net, diameters, containment evidence,
and local-clearance evidence. Dry-run checks stale state, API/source coverage,
keepout intersection, and via collisions, then returns `applyRequest` only when
every candidate is ready:

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-ground-vias.js --input-file <plan.json>
```

Apply uses the exact dry-run fingerprint, creates at most 200 vias, reads back
each primitive, confirms pre-existing vias remain, and returns a targeted
rollback request. It does not save or repour. Unresolved source keepout geometry
blocks apply rather than being bypassed.

Necessary return examples include component, decoupling, thermal, ESD, and
signal-transition reference vias. Each accepted candidate needs a reason and an
anchor; proximity alone is not proof of need.

## 3. Verify before optimizing

After necessary-via writes:

- repour affected copper;
- run configured DRC;
- read back exact new primitives and relevant fill state;
- visually review the intended return zones; and
- preserve drill evidence matched to the accepted source.

Missing necessary returns remain blockers or explicit unresolved evidence. Do
not enter global optimization merely because the first apply succeeded.

## 4. Plan optional global stitching

Use `scripts/actions/pcb-ground-stitching.js` as a read-only planner for
`plane-grid`, `edge-fence`, and `signal-transition-return` strategies. It
requires declared realized positive-layer GND pours, resolves board outline and
blocking Regions, inventories pads/tracks/arcs/vias, scores candidates, and never
creates vias.

For `edge-fence`, it parameterizes cumulative perimeter, applies hard geometry
filters, seeds coverage with nearby existing GND vias, and adds deterministic
farthest-point candidates only when they reduce the maximum cyclic gap.
`maxCount` is a ceiling, not a fill target.

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-ground-stitching.js --input-file <generation.json>
```

Never send planner output directly to apply. Route its `nextRequest` through
`pcb-ground-vias.js` `mode: plan` so the second dry-run rechecks fingerprint,
source/API keepout coverage, and via collisions. Non-convex edge fencing and
unsupported outline, Region, pad, or arc geometry stay blocked. Internal-plane
Regions need separate source-backed evidence before counting as completed
stage-one ground structure.

## Exit checkpoint

Accept the grounding state only with:

- necessary-return rationale and exact via readback;
- optional-stitching rationale distinguished from required work;
- current pour, DRC, source, and drill evidence;
- unaffected pre-existing vias/connectivity preserved; and
- explicit blockers or accepted risk for anything unresolved.

Read-only diagnosis never saves, repours, or changes persistent rules. Every
manual edit invalidates conflicting cached requests.
