# EasyEDA Pro Provider boundary

Read this reference for EasyEDA object identity, source/capture evidence,
official-API selection, and Provider-specific fact boundaries. It is an index,
not the procedure for every EasyEDA task.

Load the workflow that matches the current operation directly:

- Local Adapter, Bridge, handshake, reconnect, or pairing:
  [environment.md](providers/easyeda-pro/environment.md)
- PCB layer structure, component geometry, functional keepouts, or realized
  reference copper: [pcb-foundation.md](providers/easyeda-pro/pcb-foundation.md)
- Necessary ground vias, signal-transition returns, or global stitching:
  [pcb-grounding.md](providers/easyeda-pro/pcb-grounding.md)
- Cross-Provider Action contracts and Host/EDA runtime boundaries:
  [local-actions.md](local-actions.md)
- DRC interpretation and manufacturing-output acceptance:
  [pcb-review.md](pcb-review.md)

Do not load every Provider workflow for a single operation.

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
probe. Verify the distinctions that affect the operation:

- device, symbol, footprint, purchase part, and project instance;
- symbol pins versus copper pads, exposed/independent pads, holes, slots, vias,
  graphics, and component bodies; and
- coordinates, rotation, units, layers, readback types, async behavior, and
  BOM/PCB flags.

Use exact identifiers or a unique exact name, not the first fuzzy result. For
moves or rotations, prove ownership, expected counts, and semantic orientation
from real geometry. Unknown routed copper or member objects keep a broad move
blocked until the change closure is known.

## Use registered Actions as the execution interface

`scripts/actions/manifest.json` is the machine-readable catalog for contract
version, domain, runtime, tested Providers, modes, mutation class, and expected
capabilities. The manifest owns what is implemented; this reference explains
how EasyEDA evidence should be interpreted.

```text
node scripts/action-runner.mjs list
node scripts/action-runner.mjs run --action eda-capabilities
```

Method presence is preflight evidence, not proof that it succeeds on every
object. A mutating mode still requires the live-EDA lock in `SKILL.md`, explicit
authorization, an exact dry-run/apply request, readback, and a recoverable
failure path. Direct `eda-host.mjs execute` remains a development or diagnosis
escape hatch, not the preferred reusable interface.

## Prefer APIs that strengthen evidence

Prioritize API families that improve facts or remove repeated manual work:

- net primitive lookup, length, and netlist readback;
- DRC rule, differential-pair, equal-length, and pad-pair groups;
- canvas calculation status for bounded waits;
- Gerber, IPC-D-356A, BOM, pick-and-place, test-point, and PDF outputs;
- document events for invalidating cached plans; and
- board-outline and primitive-bounding-box queries.

Treat an available method as a capability to probe, not authorization to use it.
Keep autorouting, automatic layout, routing deletion, whole-rule replacement,
raw source replacement, and ordering/payment outside ordinary reusable Actions
unless the user authorizes a separately recoverable workflow. The official API
is beta, so current documentation, live feature detection, and readback remain
mandatory.

## Keep Provider claims narrow

- A PASS claim cites raw readback, not intention or a generated plan.
- Silence, an unresolved Promise, or a timeout is failure.
- Manual pin, footprint, placement, routing, outline, or keepout edits invalidate
  conflicting cached plans.
- Project-specific nets, coordinates, and acceptance values belong in project
  configuration or requests, not copied helper cores.
- A helper limit is evidence about that helper, not an undocumented EasyEDA
  platform limit.

Official documentation, a verified local Bridge, console scripts, and
third-party assistants are transports rather than evidence authorities. The
same identity, authorization, transaction, and readback contract applies to
all.
