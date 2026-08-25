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

Read-only diagnosis does not save, repour, switch persistent rules, or mutate the
document. Deletion, broad import, autorouting, repour, footprint replacement, or
bulk rule changes need a recoverable source checkpoint.

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
