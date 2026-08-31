# EasyEDA Pro schematic workflow

Read this workflow when a validated `SchematicContract` must be realized or
reconciled in an EasyEDA Pro schematic.

## Use one boundary and three provider stages

The portable/provider boundary is intentionally narrow:

```text
SchematicContract -> Contract Audit
                         |
                         v
                 EasyEDA Components -> Connect -> Finalize
```

The normal catalog exposes `schematic-contract-audit` plus three workflows:
`easyeda-schematic-components`, `easyeda-schematic-connect`, and
`easyeda-schematic-finalize`. Their fine-grained Actions remain internal so the
transaction implementation is testable without making the user assemble a
long pipeline by hand.

`SchematicContract v1` remains portable. EasyEDA library UUIDs, native IDs,
symbol geometry, API capabilities, and write behavior start after the Audit
boundary. Another EDA can implement the same three outcomes with different
native primitives.

## 1. Components: resolve, lay out, place

### Resolve native devices

The resolver consumes the Contract directly and returns an ephemeral
`providerBindings` map keyed by designator. Existing
`components[].bindings.easyedaPro` entries are accepted as a project cache;
there is no separate BindingSet artifact.

For an exact component, automatic selection requires one untruncated candidate
with native library/device IDs and exact normalized equality for every required
reported field, including MPN, manufacturer, and exact footprint. Substring
matches never auto-select. Generic values, missing evidence, multiple exact
matches, and more than 25 search results require an explicit selection. Library
search failure is reported separately from zero results.

Semantic Contract pins may map to one or more native symbol pins through
`pinMap`. Map keys must be declared Contract pins and map values must be
non-empty. Physical pin count is checked only when the Contract explicitly
supplies an EasyEDA expected pin count; semantic pin count is not assumed to be
physical package pin count.

### Calculate placement

The internal layout Action combines the Contract and resolved bindings into
`SchematicPlacementPlan v1`. Its `cluster-bbox-v3` layout:

- preserves Contract block order unless an explicit block order overrides it;
- creates one cluster per main device and attaches `near` dependents;
- honors connector direction hints;
- uses catalog symbol width, height, and pin-side geometry when available;
- otherwise estimates conservative symbol geometry from declared pins and
  footprint hints, while reporting that fallback;
- swaps the occupied width and height for 90/270 degree symbol rotation;
- packs complete cluster/block bounding boxes with routing-lane clearance;
- snaps positions to the configured grid; and
- reports remaining rectangle overlap as a blocker.

PCB footprint shape is only a fallback hint, never authoritative schematic
symbol geometry. For an important or unusual symbol, provide measured symbol
geometry in the layout catalog. If the API cannot supply it before placement,
use a roomy staging placement, capture the live symbol, then perform a later
bounded move; inferred geometry must not be called live evidence.

### Place transactionally

Placement plan mode rejects missing bindings, duplicate or occupied
designators, the wrong document, and more than 50 requested components. Apply
creates components, sets the designator, protects every pre-existing primitive
ID, and returns a fingerprint-gated rollback request. Verification always checks
created ID, designator, position, rotation, mirror, and BOM/PCB flags. Native
library identity is `unknown` when EasyEDA does not expose it reliably on
readback; it is not treated as a false failure or a false pass. Placement does
not save the document.

Current layout limitations are deliberate: it does not optimize crossings,
understand analog signal flow from first principles, measure arbitrary symbol
art before placement, or autoroute a complete schematic. It produces a safe,
deterministic first arrangement whose uncertainty is visible.

Internal handoff is direct: resolver `providerBindings` and
`bindingFingerprint` enter layout with the Contract; layout `placementPlan`
enters component-place plan mode with `expectedDocumentUuid`; only the returned
`applyRequest` may enter apply.

## 2. Connect: capture, plan endpoints, write

Connect begins with a fresh `SchematicSnapshot v1` containing document and
project identity, components, available absolute pin positions, wire polylines,
known net names, and separate coverage/fingerprints. Known net names do not
imply known endpoint membership.

The internal connection planner expands each Contract semantic endpoint through
the PlacementPlan pin map, resolves it against live native pins, and proposes
one short orthogonal endpoint stub. Direction is the dominant axis of the vector
from the live component anchor to the live pin. Stub ends are grid-snapped.

Before proposing a stub, it measures the pin-to-polyline distance for every live
wire segment using a bounded tolerance, so contact in the middle of a segment is
recognized as well as contact at a vertex:

- same known net: record the endpoint as already connected and skip it;
- different known net: block as a conflict;
- unnamed touching wire: block because connectivity is unknown;
- missing component, mapping, pin, position, or no-connect status: block.

The resulting connection plan is a transient internal Action result, not a
public schema. It is bound to the Contract, PlacementPlan binding, Snapshot,
document, and live geometry fingerprints. `schematic-wire-create` re-captures
the relevant geometry before apply, creates at most 20 flat polylines per batch,
and verifies each new primitive through `sch_PrimitiveWire.get(id/get(ids))`.
`getAll()` is global coverage evidence only. Targeted ID readback may pass while
global enumeration is separately reported as inconsistent or unknown.

Optional net flags/ports use their own plan/apply/verify/rollback transaction.
Duplicate requested symbols are rejected before apply. Supported flags are
`Power`, `Ground`, `AnalogGround`, and `ProtectGround`; supported ports are
`IN`, `OUT`, and `BI`.

Connect currently creates endpoint stubs and named flags, not long routed
connections, junction topology, buses, hierarchical labels, or a proof that the
whole Contract netlist is realized. A later router can replace the internal
planner without changing the Contract boundary or write/readback safety.

Internal handoff is likewise direct: inspect `snapshot`, the Contract, and the
current PlacementPlan enter connection planning; its transient result enters
wire-create plan mode; only returned apply requests are written. Flag items are
explicit optional input, not inferred merely from a net name.

## 3. Finalize: inspect, save, check

Finalize captures one last Snapshot, binds the save request to the selected
document and fingerprint, explicitly saves, then runs schematic DRC. `verify`
runs DRC without saving and reports `saved: false`. Save has no fake rollback.
ERC/DRC remains configured connectivity evidence, not proof of electrical
ratings, topology, or system behavior.

The inspect result and selected document UUID enter save-verify plan mode; only
its returned apply request may save.

## Transaction and timeout rules

All mutating Actions require explicit write authorization and a matching live
document. Apply and rollback requests become stale after a manual edit,
document change, geometry change, binding change, or required capability change.
Rollback deletes only primitives created by that request and proves their IDs
are gone; it never claims full-document restoration.

Set `FLITREALIZE_EDA_ACTION_TIMEOUT_MS` for the host-side deadline. A newly
started bridge inherits it unless `EASYEDA_BRIDGE_REQUEST_TIMEOUT_MS` is set.
After any mutating timeout, inspect and reconcile before retrying because a
timeout does not prove that live EDA code stopped.

EasyEDA schematic coordinates use 10 mil units. A net flag is a component
primitive, not a wire. `sch_Drc.check(strict, false, false)` returns a boolean,
not a detailed issue list.
