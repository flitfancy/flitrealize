# From concept to schematic contract

Read this reference for requirements, architecture, part selection, pin mapping,
or schematic review.

## Convert intent into a bounded design

Ask only questions that can change architecture or acceptance:

- supply range, polarity, transients, available and peak current;
- host/protocol, voltage domains, cable and hot-plug conditions;
- sensors/loads, accuracy/rate/startup and fault behavior;
- enclosure, environment, thermal/acoustic/optical constraints;
- assembly, repairability, volume, cost, and credible expansion;
- observability, safe defaults, recovery, and test method.

Record explicit non-goals. Create a block diagram and power tree before
optimizing every part. For each block capture purpose, interfaces, current,
startup/reset, fault propagation, measurement method, and supply risk. Freeze
stable external interfaces before internal optimization.

## Bound cross-domain assumptions

Identify functions whose success depends on firmware, timing, acoustics,
mechanics, thermal behavior, enclosure geometry, or an unfamiliar combined path.
Choose evidence proportional to consequence: focused calculation, simulation,
module, breadboard, or a defined arrival/bring-up test. A personal prototype can
advance conditionally when the missing proof and bounded consequence are clear.

Individually correct application circuits do not prove that the combined system
works.

## Keep machine-checkable intent

Use a project contract/configuration for facts that generation or review must
compare:

- component roles and exact purchase/footprint identity;
- expected pins/pads and critical or complete pin-to-net mapping;
- values, ratings, tolerances, substitutions, and special footprint policy;
- interface directions, bus addresses, pull-up domains, and power consumers;
- test points, board revision, and source artifact locations.

The schematic implements the design; the contract independently records intent.
Compare exported netlist or structured capture with that contract. A pin-map
change updates the owning contract, schematic source/generator, firmware
interface, capture expectations, and targeted tests as one controlled delta.

### Use the versioned portable formats

The runtime package includes
`schemas/schematic-contract.v1.schema.json` for design intent and
`schemas/schematic-snapshot.v1.schema.json` for a future provider-produced
read-only realization. Keep block, power-domain, interface, component role,
pin classification, net endpoint, constraint, exception, and evidence facts in
the portable Contract. Put EDA-native library UUIDs and similar identities only
under a namespaced component binding such as `bindings.easyedaPro`; do not make
them portable facts.

Run the provider-free `schematic-contract-audit` Host Action before a Contract
drives capture comparison or generation:

```text
node scripts/action-runner.mjs run --action schematic-contract-audit \
  --input-file <schematic-contract.json>
```

It checks the v1 shape, unique identities, cross-references, pin/net ownership,
NC/DNC isolation, power-domain and differential-pair references, functional
block membership, explicit evidence state, and opaque Provider boundaries. It
returns `passed`, `conditional`, or `blocked` plus a stable fingerprint and
compact issue list. This proves only internal contract consistency: it does not
prove electrical correctness or that an EDA document realizes the Contract.

The Snapshot schema is frozen as the target boundary for the next read-only EDA
capture Action. Until that Action and a separate Contract-to-Snapshot comparer
exist, never claim realized-schematic agreement from the Contract audit.

## Use the right fact source

1. Manufacturer datasheet for electrical facts and recommended circuits.
2. Live library capture for symbol/package geometry and platform identity.
3. Current controlled BOM for the selected value, rating, tolerance, and part.
4. Session recollection only as a lead, never as evidence.

For platform APIs, consult current official documentation and confirm unfamiliar
behavior with a read-only probe. Do not place a new device or answer a critical
parameter from training memory alone.

Archive an exact datasheet revision when it materially supports a decision that
must remain reproducible; do not turn routine passives into documentation work.

## Review in functional order

1. **Power entry:** range, reverse/surge/ESD protection, fuse behavior, returns,
   and connector rating.
2. **Regulators and loads:** headroom, loss/temperature, enable defaults,
   capacitor value/derating/stability, startup, discharge, and peak current.
3. **Voltage domains:** translation direction, thresholds, pull-ups, reset, and
   protection rail compatibility.
4. **Interfaces:** mating pinout/orientation, disconnected and cable-fault
   behavior, and ESD path.
5. **Digital buses:** addresses, equivalent pull-ups, capacitance, topology, and
   recovery.
6. **Sensors/actuators:** primary circuit, openings, exposed/no-connect pads,
   calibration/handling, and safe drive state.
7. **BOM/footprints:** MPN/package match, derating, lifecycle, substitutions,
   inventory evidence, and separation of purchase identity from geometry donors.

Use ERC as configured connectivity evidence, not proof of topology, ratings, or
system behavior. Bound intentional exceptions.

## Add a human overview only when useful

For a complex project or manual EDA collaboration, derive `ALL_VIEW.md` (or an
equivalent overview) from the contract and BOM. Useful sections include component
roles, functional blocks, swappable pins, and later the routing plan. Keep its
revision pointer synchronized, but do not make this derived file a prerequisite
for a small project whose contract is already readable.

## Common traps

- A load switch is not automatically a current limiter.
- Same-name or same-voltage nets do not prove safe domain equivalence.
- Average current does not replace peak/transient analysis.
- An unconnected pad needs classification as DNC, NC, ground/thermal, or error.
- Drawing neatness does not replace a functional contract.
