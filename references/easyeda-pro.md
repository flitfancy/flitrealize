# EasyEDA Pro source, capture, and automation

Read this reference for EasyEDA object identity, live capture, Bridge/console
automation, or version-matched exports.

## Pair facts with one source revision

- Treat an identified `.epro2` copy as the saved source archive for an order
  candidate.
- Use saved source or structured live capture for component, pad, net, layer,
  rule, and geometry facts. Canvas appearance is supporting evidence only.
- Pair exports with source using hashes, configuration identity, timestamps, and
  useful object counts. Archive approved outputs under the project root without
  overwriting reviewed baselines.

## Probe unfamiliar behavior before scaling

Use current official API documentation, then a minimal read-only real-object
probe. Verify the identities and distinctions that affect the operation:

- device, symbol, footprint, purchase part, and project instance;
- symbol pins versus copper pads, exposed/independent pads, holes, slots, vias,
  graphics, and component bodies;
- coordinates, rotation, units, layers, readback types, async behavior, and
  BOM/PCB flags.

Use exact identifiers or a unique exact name, not the first fuzzy result. For
moves or rotations, prove ownership, expected counts, and semantic orientation
from real geometry. Unknown routed copper or member objects keep a broad move
blocked until the change closure is known.

## Make each live write a recoverable transaction

Apply the full live-EDA lock in `SKILL.md`, then use one decision core for:

1. **Preflight:** exact project, PCB/document, target IDs/counts, entry state,
   channel availability, stale/forbidden artifacts, and affected-object bound.
2. **Snapshot:** complete change closure plus global invariants needed to detect
   collateral changes and restore state.
3. **Apply:** only the authorized delta, with bounded async behavior and
   observable start/final status.
4. **Readback:** compare normalized identity, membership, geometry, counts, and
   operation-specific invariants with the expected post-state.
5. **Rollback:** on partial success, timeout, mismatch, or exception, restore the
   captured closure and verify restoration. If full rollback is unavailable,
   stop and present the exact recoverable state.

Read completion state before choosing a local repair or rollback; do not blindly
rerun the complete apply. Topology changes also require a post-operation netlist
comparison against `pre-state + authorized delta`, with unaffected connectivity
unchanged.

### Use the registered action protocol

Treat `scripts/actions/manifest.json` as the machine-readable action catalog.
It declares each portable action, supported mode, mutation class, and expected
API capabilities. List the current interface without loading action source:

```text
node scripts/action-runner.mjs list
```

Use the runner for repeated work so input stays separate from executable code,
successful output stays compact, and the complete Bridge response is retained
in a host-local report:

```text
node scripts/action-runner.mjs run --action eda-capabilities
```

The read-only `eda-capabilities` action fingerprints method presence in the
active EasyEDA API surface. Presence is preflight evidence, not proof that a
method will succeed on every object. A registered mutating mode is rejected
unless `--allow-write` is present; that switch records the chosen execution
path but never replaces the live-write authorization and transaction lock in
`SKILL.md`. Use `--full` only when the complete response must enter the calling
process; otherwise read the local report only for a specific failure or exact
geometry need. Direct `eda-host.mjs execute` calls remain the lower-level escape
hatch for developing or diagnosing an action.

### Build copper layers from a plan

Treat layer construction as a design-backed transaction, not a shortcut to a
fixed four-layer template. The plan declares the exact document, copper-layer
count, ordered per-layer role, inner-layer name and type, intended reference or
plane net, and provenance of any physical stack or impedance target. Capture the
current layer list and physical stack first; lowering layer count is a separate
destructive review because populated inner layers may be removed.

The portable action `scripts/actions/pcb-layer-stack.js` can inspect, apply,
verify, and immediately roll back layer structure through the registered host
adapter. Pass action data without embedding it into the helper source:

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-layer-stack.js --input-file <action.json>
```

Setting a layer role or naming a plane net does not itself prove copper exists.
For a positive signal layer, create and rebuild the intended pour while honoring
board outline and keepouts; for an internal plane, verify its assigned regions
and net. Then read back the realized copper separately. Physical stack values
remain project/manufacturer facts and are not overwritten by this action.

### Protect functional no-copper zones before pouring

Do not infer all copper restrictions from board-level Region queries alone.
Inspect the exact live component and footprint geometry first with
`scripts/actions/pcb-component-geometry.js`, including pads, slots, document
source context, and the primitive bounding box. Classify each restriction by its
engineering purpose: antenna clearance, acoustic opening, exposed-pad thermal
area, isolation, mounting/mechanical clearance, or manufacturer-defined
keepout. A package courtyard or silkscreen outline is not automatically a
copper keepout.

Use `scripts/actions/pcb-functional-keepouts.js` to plan, apply, verify, or roll
back an exact bounded set of board Regions. The plan declares geometry, layer,
rule types, provenance, and a protected-geometry fingerprint. Apply reads back
every created ID and returns an IDs-only rollback request; it does not save or
repour. If the current API omits a Region name or normalizes display line width,
verification relies on exact ID, geometry, layer, rules, lock state, and
protected invariants rather than those cosmetic fields.

### Close grounding in three stages

Treat grounding as one closure flow with a read-only entry audit and a common
exit gate:

1. **Establish realized reference copper.** Resolve the stack, board outline,
   functional keepouts, intended plane nets, and generated pour fills.
2. **Close necessary returns.** Add the smallest justified set of
   component/decoupling/thermal/ESD vias and signal-transition reference vias.
   Missing necessary returns remain blockers or explicit unresolved evidence.
3. **Optimize global stitching.** After placement, routing, keepouts, and the
   first two stages are stable, optionally plan sparse-area stitches, edge
   fences, and other board-wide return improvements. More vias are not an
   acceptance criterion.

After any write, repour where relevant, run configured DRC, read back the exact
new primitives, visually review the intended zones, and match drill output to
the accepted source. A manual edit invalidates cached plans from any stage.

### Create and verify realized copper pours

Use `scripts/actions/pcb-ground-pours.js` only after board outline and functional
keepouts are resolved. It supports inspect, plan, apply, verify, and targeted
rollback. The action extracts the exact closed board outline, captures protected
component/track/via invariants, creates one bounded pour at a time, rebuilds it,
and reads back both the pour border and generated `Poured` fill objects. It does
not save the document.

A successful border readback is not proof that copper exists or that keepouts
were honored. Verify the generated fill paths and probe every declared critical
keepout point against both realized copper and clearance contours. Establish an
early checkpoint on one layer before scaling to the remaining layers. Because
the polygon and containment APIs are beta and have shown version-dependent
behavior, feature-detect them and retain tested analytic fallbacks for supported
outline primitives; unsupported geometry stays blocked.

### Audit grounding before placing planned vias

Use `scripts/actions/pcb-grounding-inspect.js` as the read-only inventory action.
It enumerates every API-visible pour, region, via, and component; groups pours by
net and layer; reports GND-via proximity for selected designators; and scans both
the current document source and document footprint sources. The source scan
distinguishes instantiated keepout records from the
`PROHIBITEDREGION` display-configuration token so an API query-range gap is not
silently treated as an empty board.

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-grounding-inspect.js --input-file <inspect.json>
```

The result includes `inspectionFingerprint`, query/source coverage, all pour
networks, API-visible keepout geometry, and unresolved footprint keepout
evidence. The fingerprint also covers component placement/pad summaries and the
non-UI document/footprint source records. Keep the raw result with the proposed
via plan; a later manual change to placement, routing, pours, regions, vias, or
keepout source invalidates it.
The default `detailLevel: summary` still scans every object but keeps the bridge
result compact; request `detailLevel: full` only when exact primitive geometry is
needed to build a candidate plan.

Use `scripts/actions/pcb-ground-vias.js` as the separate generation and
transaction action. `mode: generate` resolves exact designators and GND pad
numbers, reads live pad coordinates and shapes, and proposes a bounded number of
cardinal-offset via candidates. It selects candidates that avoid resolved board
keepouts and existing/planned vias, but returns blockers until board containment
and local copper/pad/track clearance have independent evidence. Custom pad
geometry without a proven fallback radius also stays blocked.
Generation defaults to a compact summary; request `detailLevel: full` only when
the rejected candidate geometry is needed for diagnosis.

Alternatively, `mode: plan` accepts an exact bounded list of externally chosen
candidate vias. Both paths require document identity, the inspection
fingerprint, net, diameters, board-containment evidence, and local-clearance
evidence. The dry-run checks stale state, API/source coverage, board keepout
intersection, and existing/planned via collisions. It returns an `applyRequest`
only when every candidate is apply-ready:

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-ground-vias.js --input-file <plan.json>
```

Apply uses the exact dry-run fingerprint, creates at most 200 vias, reads back
each primitive, checks that pre-existing vias remain, and returns a targeted
rollback request. It does not save or repour. If a keepout appears in document
or footprint source but cannot be resolved to board geometry through the API,
apply is blocked rather than bypassing it. T1 still requires a subsequent DRC,
repour/readback where relevant, and visual review before the new vias are
accepted.

Use `scripts/actions/pcb-ground-stitching.js` as the separate read-only planner
for the global optimization stage and for signal-transition return candidates.
It currently requires declared realized positive-layer GND pours, resolves the board outline and
blocking Regions, inventories pads/tracks/arcs/vias, and supports bounded
`plane-grid`, `edge-fence`, and `signal-transition-return` strategies. It never
creates vias. The planner scores and filters proposals, records the rationale
and anchor for every selected candidate, and emits a plan for the existing
`pcb-ground-vias.js` transaction action:

For `edge-fence`, it parameterizes the complete cumulative perimeter, generates
a bounded denser candidate set (four samples per requested spacing by default),
and applies hard geometry filters before selection. Nearby existing GND vias
seed equal-perimeter coverage bins; new candidates fill uncovered bins, then a
deterministic farthest-point pass adds a candidate only when it reduces the
combined maximum cyclic perimeter gap. The result reports existing/new bin
coverage and before/after maximum gaps. `maxCount` is a ceiling, not a fill
target.

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-ground-stitching.js --input-file <generation.json>
```

Do not send its output directly to apply. Run the returned `nextRequest` through
`pcb-ground-vias.js` `mode: plan`; that second dry-run rechecks the grounding
inspection fingerprint, source/API keepout coverage, and planned/existing-via
collisions before it can produce an apply request. Edge fencing currently stays
blocked for non-convex outlines; unsupported outline, Region, pad, or arc
geometry remains evidence to resolve rather than a reason to bypass clearance.
Internal-plane Regions need separate source-backed evidence before this planner
can treat them as a completed stage-one ground structure.

Read-only diagnosis does not save, repour, switch persistent rules, or mutate the
document. Deletion, broad import, autorouting, repour, footprint replacement, or
bulk rule changes need a recoverable source checkpoint.

## Prioritize high-value official APIs

Prefer API families that improve evidence or remove repeated manual work:

- net primitive lookup, net length, and netlist readback for connectivity and
  length audits;
- DRC rule, differential-pair, equal-length, and pad-pair groups for
  design-backed constraints and semantic verification;
- canvas calculation status for bounded waits instead of fixed delays;
- Gerber, IPC-D-356A, BOM, pick-and-place, test-point, PDF, and other
  manufacturing outputs for source-matched release evidence;
- document events for invalidating cached plans after manual edits; and
- board-outline and primitive-bounding-box queries for geometry-backed planning.

Treat every available method as a capability to probe, not as authorization to
use it. Keep autorouting, automatic layout, routing deletion, whole-rule
replacement, raw document-source replacement, and ordering/payment operations
outside normal reusable actions unless the user explicitly authorizes a
separately recoverable workflow. Some manufacturing methods are deployment
specific. The official API is beta, so current documentation plus live feature
detection and readback remain mandatory.

## Keep scripts observable and current

- Give user-operated scripts as files with the required active document,
  expected visible result, and stop condition.
- Feature-detect optional UI feedback and always emit a machine-readable console
  or report result. Silence, unresolved Promise, or timeout is failure.
- A PASS claim cites raw readback, not intention or a generated plan.
- After manual pin, footprint, placement, routing, outline, or keepout changes,
  capture state and reconcile the owning contract before reusing apply scripts.
- Keep one current diagnose, apply, verify, and targeted regression entrypoint
  per action. Project-specific nets, coordinates, and acceptance values belong
  in configuration/adapters rather than copied helper cores.

## Reuse one host adapter without repeated discovery

Keep the Bridge transport/server outside the portable core skill. Register its
local installation once in the machine profile, then let the helper start or
reuse it; portable action files still execute only through that adapter:

```text
node scripts/eda-host.mjs register --eda easyeda-pro --adapter-root <adapter-root>
node scripts/eda-host.mjs ensure --eda easyeda-pro --require-eda
```

The host profile may contain machine paths; project state and the public skill
must not. A project may declare its expected EDA and document in
`.flitrealize/project.json`. Treat a declared/connected EDA mismatch as a hard
identity failure before any live operation.

Run the lightweight authenticated handshake before the first live EDA access in
an agent session, not on every chat turn. Reuse the result only while Bridge
session ID, adapter/EDA identity, selected window, and intended document remain
unchanged. Re-probe after disconnect, EDA restart, window/document change,
adapter/API version change, capability failure, or project mismatch.

If the Bridge starts after the EasyEDA gateway has exhausted its retry cycle,
the helper reports `EDA_NOT_CONNECTED`. Use **API Gateway -> reconnect** once;
starting the Bridge before opening EasyEDA avoids this recovery step.

Use the helper rather than direct unauthenticated HTTP calls. The local adapter
keeps the per-session token out of prompts and returns a compact structured
status. Raw code execution is a development transport, not authorization or
proof; all live writes still require the transaction and readback contract
above.

Treat Agent authentication and EDA-gateway pairing as separate claims. If the
installed gateway cannot present a pairing credential, classify the channel as
local-development rather than cryptographically EDA-authenticated. Keep it
localhost-only, verify the real project/document with a read-only probe, and do
not use that mode as a shared or hostile-host security boundary.

## Keep platform methods outside the governance reference

When the host or project provides a reusable network-class helper, palette, or
adapter record, treat only its tested behavior as implementation evidence.
Helper limits must not be presented as undocumented EasyEDA platform limits.
Keep other drifting API facts and proven traps in the configured knowledge
catalog when one exists, or in project-local evidence otherwise.

Official documentation, a verified local Bridge, console scripts, and
third-party assistants are transports rather than evidence authorities. The same
identity, authorization, transaction, and readback contract applies to all.

For DRC interpretation and Gerber/drill/manufacturer preview checks, use
[pcb-review.md](pcb-review.md) rather than duplicating manufacturing guidance
here.
