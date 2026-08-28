# EasyEDA Pro schematic workflow

Read this workflow when placing components, drawing wires, adding net flags,
or running schematic DRC through the Action system.

## Inputs

- `SCHEMATIC_CONTRACT.v1.json` for design intent (component roles, net
  mapping, pin assignments);
- resolved library UUIDs and device UUIDs from the contract or a library
  search; and
- active schematic document confirmed as `easyeda-pro`.

## Place components first

Use `schematic-component-place` in `plan` mode with an array of items, each
specifying `libraryUuid`, `uuid`, `x`, `y`. The Action reads back every
created primitive and verifies it survived. On any failure, all newly created
components are rolled back automatically.

```text
node scripts/action-runner.mjs run --action schematic-component-place \
  --input-file plan.json --allow-write --eda easyeda-pro --project-root <root>
```

The plan JSON shape:

```json
{
  "mode": "apply",
  "plan": {
    "expectedDocumentUuid": "<schematic-uuid>",
    "items": [
      {
        "libraryUuid": "<lib-uuid>",
        "uuid": "<device-uuid>",
        "x": 2000,
        "y": 3000,
        "rotation": 0,
        "mirror": false,
        "addIntoBom": true,
        "addIntoPcb": true
      }
    ]
  },
  "expectedPlanFingerprint": "<from-plan-dry-run>"
}
```

## Add net flags and ports after placement

Use `schematic-net-flag` in `apply` mode. Two kinds are supported:

- `netFlag`: power/ground symbols with identification `Power`, `Ground`,
  `AnalogGround`, or `ProtectGround`.
- `netPort`: directional ports with direction `IN`, `OUT`, or `BI`.

Both require a net name and coordinates. The created primitives are returned
with their primitiveId for subsequent verification.

## Draw wires last

Use `schematic-wire-create` in `plan` mode. Each wire item needs a `net`
name and a `points` array of `{x, y}` pairs (minimum 2). The Action calls
`sch_PrimitiveWire.create()` with the `[[x1,y1],[x2,y2],...]` line format
that EasyEDA expects.

## Save and verify

After all mutations, use `schematic-save-verify` in `verify` mode to save
the document and run `sch_Drc.check()`. This is read-only from the Action
framework's perspective (the save is an EDA-side operation, not a framework
mutation).

## Capability requirements

All schematic Actions declare their required API methods in the manifest.
The `eda-capabilities` Action now includes `sch.*` checks alongside the
existing `pcb.*` checks. Run it before the first schematic Action in a
session to confirm the API surface is available.

## Staleness and re-probe

Re-run `schematic-inspect` after any manual edit to the schematic. The
inspection fingerprint changes whenever components or wires are added,
removed, or moved. A stale fingerprint invalidates any pending plan or
rollback request.

## Common traps

- The `component` parameter for `sch_PrimitiveComponent.create()` accepts
  an `ILIB_DeviceSearchItem` or `{libraryUuid, uuid}`. Do not pass a bare
  string.
- Coordinates are in EasyEDA schematic units (10 mil). A typical A4 sheet
  spans roughly 15000 x 10000 units.
- `createNetFlag` creates a component (not a wire). It appears in
  `sch_PrimitiveComponent.getAll()`, not in wire lists.
- `sch_Drc.check(strict, false, false)` returns a boolean, not an error
  list. Use `strict: true` for pre-production checks.
