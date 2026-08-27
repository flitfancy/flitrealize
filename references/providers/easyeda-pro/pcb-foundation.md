# EasyEDA Pro PCB foundation workflow

Use this workflow to establish the physical PCB foundation in this order:

```text
layer plan -> live geometry -> functional keepouts -> realized reference copper
```

It does not add ground vias or optimize stitching; continue with
[pcb-grounding.md](pcb-grounding.md) only after the realized-copper checkpoint
passes.

## Entry evidence

- exact project and PCB document identity;
- design-backed copper-layer count and ordered roles;
- board outline and current physical stack capture;
- intended reference/plane nets;
- component/footprint identities for functional clearances; and
- the live-write authorization state required by `SKILL.md`.

Lowering the layer count is a separate destructive review because populated
inner layers may be removed.

## 1. Inspect and realize the layer plan

`scripts/actions/pcb-layer-stack.js` can inspect, plan, apply, verify, and
immediately roll back the layer structure. Pass data separately from helper
source:

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-layer-stack.js --input-file <action.json>
```

The plan declares ordered layer roles, inner-layer names/types, intended plane
nets, and provenance for physical stack or impedance targets. Setting a role or
plane-net name does not prove copper exists. Physical stack values remain
project/manufacturer facts and are not overwritten by this Action.

Checkpoint output:

- verified layer identities and order;
- accepted physical-stack evidence or explicit unknowns; and
- no unexplained lost inner-layer content.

## 2. Resolve functional no-copper geometry

Do not infer every restriction from board-level Region queries. Inspect exact
live component and footprint geometry with
`scripts/actions/pcb-component-geometry.js`, including pads, slots, document
source context, and primitive bounding boxes.

Classify each restriction by engineering purpose: antenna clearance, acoustic
opening, exposed-pad thermal area, isolation, mounting/mechanical clearance, or
manufacturer-defined keepout. Courtyard or silkscreen outlines are not
automatically copper keepouts.

Use `scripts/actions/pcb-functional-keepouts.js` to plan, apply, verify, or roll
back an exact bounded set of board Regions. The request owns geometry, layer,
rule types, provenance, and protected-geometry fingerprint. Apply returns every
created ID and an IDs-only rollback request; it does not save or repour.

If API readback omits a Region name or normalizes display line width, verify
exact ID, geometry, layer, rules, lock state, and protected invariants rather
than cosmetic fields. Unresolved functional geometry remains a blocker.

## 3. Create and prove realized reference copper

Use `scripts/actions/pcb-ground-pours.js` only after board outline and functional
keepouts are resolved. It supports inspect, plan, apply, verify, and targeted
rollback. The Action captures protected component/track/via invariants, creates
one bounded pour at a time, rebuilds it, and reads back both the pour border and
generated `Poured` fill objects. It does not save the document.

A border is not proof of copper. Verify generated fill paths and probe every
declared critical keepout point against both realized copper and clearance
contours. Establish an early checkpoint on one layer before scaling. Polygon and
containment APIs are beta and version-dependent; use feature detection and only
tested analytic fallbacks. Unsupported geometry stays blocked.

## Exit checkpoint

Produce or retain:

- verified ordered copper-layer state;
- protected functional-geometry fingerprint;
- exact pour IDs, nets, layers, borders, and generated fill evidence;
- blockers/unknowns instead of guessed geometry; and
- a current source/document fingerprint for the grounding workflow.

After any write, repour where relevant, run configured DRC, read back exact new
primitives, visually review intended zones, and match drill output to the
accepted source. A manual edit invalidates the affected plan.

Deletion, broad import, autorouting, footprint replacement, or bulk rule changes
remain separate recoverable workflows with explicit authorization.
