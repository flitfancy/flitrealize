# PCB placement, routing, and manufacturing review

Read this reference for placement, routing, planes, configured DRC, or
Gerber/drill review.

## Establish layout intent

Choose the mode that matches the request:

- **topology map:** make groups and must-near/keep-away relationships obvious;
- **compact candidate:** target a stated envelope without breaking topology,
  access, or routing channels;
- **preserve manual:** freeze accepted user work and use explicit local deltas.

Record the envelope as hard or aspirational, plus anchors, edge interfaces,
functional groups, critical relationships, keepout/noise/RF/acoustic/mechanical
zones, and the visual acceptance criterion. Distinguish useful empty antenna,
acoustic, thermal, assembly, and routing space from waste.

Validate one consequential block and the overall zone map before full placement.
Offline collision checks are `automated-green`; real package geometry and
visual/3D acceptance establish different evidence.

## Place by relationships, not decoration

Review functional flow before alignment:

- connector -> protection -> protected circuit;
- regulator input/output and switching loops;
- local bypass, crystal/reference/feedback paths;
- high-current/heat/noise separation from sensitive blocks;
- sensor aperture, airflow, light, contamination, and thermal isolation;
- mating, mounting, height, rework, test, and assembly access.

Use copper/pad geometry and component bodies for dense or unusual footprints.
Express orientation semantically—mating opening, protected side, pin-1/net
contract, port field—rather than as one board-edge rotation. Reusable orientation
logic should tolerate allowed whole-group rotations and reject independent
reversal, wrong footprint identity, and obstructed access.

## Choose the stack from the design

Use the lowest layer count that still gives every critical signal a defensible
reference path, enough routing channels, appropriate power/thermal capacity and
noise isolation, and a manufacturable cost. Two, four, or more copper layers are
outcomes, not defaults. For each candidate, record the ordered role of every
copper layer, which reference plane each critical route uses, allowed layer
changes, plane nets or pours, keepouts, and the source of physical stack and
impedance values.

Prefer continuous reference planes over fragmented convenience pours, but do
not reserve extra planes without a design benefit. Treat a pattern such as
signal / ground / ground / signal as one useful candidate, not a universal
rule. Re-evaluate the choice when interfaces, placement, enclosure, fabricator,
cost target, or routing evidence changes.

## Route from an explicit contract

Before routing, record net classes, nominal/minimum widths, clearances, via and
layer policy, topology, return-path needs, and ordered critical routes in the
machine contract or chosen human overview. Route and verify one risk class at a
time.

Review:

- main/branch power bottlenecks, neck-down length, via capacity, and return
  impedance;
- critical topology, stubs, layer changes, coupling, and uninterrupted return;
- ground pours, islands, corridors, splits, and local stitching;
- ESD path and loop area;
- thermal spokes, annular rings, mask slivers, holes/edges, polarity, silkscreen,
  and assembly access.

Close grounding in three stages rather than treating via count as the goal:

1. **Establish the ground structure:** resolve keepouts, create/rebuild the
   intended planes or pours, and prove realized copper exists.
2. **Close necessary returns:** prioritize component/decoupling/thermal/ESD
   ground paths and nearby reference vias where signals change layers.
3. **Optimize global stitching:** only after routing is stable, add a bounded
   set of useful plane stitches, edge fences, zone fences, or sparse-area vias.

Use read-only geometry and grounding inventory before the stages, then repour,
run configured DRC, read back the added primitives, and verify drill output at
the exit gate. A regular via grid is optional evidence-driven optimization, not
a universal requirement. For an edge fence, evaluate existing and proposed GND
vias together along cumulative board perimeter; blocked sectors remain explicit
coverage gaps, and the planner should stop when another safe candidate no longer
reduces the maximum cyclic gap.

Separate a wide trunk from permitted pad escape. Record escape width, maximum
neck-down length, transition point, and via strategy where the pad cannot accept
the trunk. Global fabrication minima do not define every functional route.

When importing rules, verify definitions and actual net assignments separately.
Keep fabrication minima, named net-class rules, and interactive defaults distinct.
Manually route critical power, protection, clocks/high-speed links, feedback, and
sensor paths. Autorouting is suitable only for bounded residual nets followed by
topology and net-class review.

## Treat environment as part of the PCB

Apply only the relevant constraints: thermal/airflow isolation for environmental
sensors, unobstructed pressure/acoustic/optical ports, contamination-safe VOC/NOx
areas, local peak-current decoupling, RF keepouts, and enclosure/mechanical stress.
Define necessary electrical fanout exceptions rather than treating every empty
zone as an absolute copper ban.

## Interpret evidence correctly

A clean configured DRC proves rule compliance, not pinout, BOM, power integrity,
EMC/ESD, thermal behavior, enclosure fit, or reliability. Review the rule set.
A screenshot proves visual properties, not connectivity or exact clearance.
Numeric geometry and visual acceptance complement rather than replace each other.

## Cross-check manufacturing output

Pair the identified source/export revision and verify the applicable items:

- closed outline and dimensions;
- copper, mask, paste, silkscreen, mechanical, and drill layers;
- PTH/NPTH tools, slots, counts, and diameters;
- expected routed connectivity from source/capture;
- top/bottom population versus paste/assembly outputs;
- pours, keepouts, tenting, polarity, text, and bottom-side direction;
- the selected fabricator's current preview and capabilities.

Gerber lacks component/net semantics. Use source/capture for identity and
connectivity, rendered composites for visual review, and numeric checks for the
manufacturing facts they can prove.
