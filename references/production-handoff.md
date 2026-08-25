# Project initialization, procurement, and manufacturing handoff

Read this reference for a new project root, inventory/procurement identity, or a
manufacturing/order candidate. Cross-chat state ownership lives in
[continuation.md](continuation.md).

## Initialize only an explicit new project

A concept discussion does not create files. When initialization is requested:

1. Apply the full root/scope lock from `SKILL.md`. Use the workspace parent
   explicitly provided by the user or host. If none is available and the
   destination would change the result, ask one narrow location question.
   Protect any source project.
2. Choose a descriptive non-colliding child directory. Stop rather than merge
   into an existing directory that may contain work.
3. Create only the files needed now: normally a short `README.md` pointing to
   `CURRENT_HANDOFF.md`, plus the initial handoff. Add deeper EDA, test, capture,
   generated, or artifact directories when work reaches them.
4. Record only facts established by this project. A derived project may reuse
   methods or selected source material, but not the baseline project's state,
   decisions, or passed gates.

A useful structure can grow toward:

```text
project/
├── README.md
├── CURRENT_HANDOFF.md
├── DESIGN.md or project.config.*
├── references/
├── captures/
├── tests/
├── generated/
└── artifacts/
    ├── source/
    ├── gerber/
    ├── assembly/
    └── preview/
```

Generated files remain rebuildable and do not own design intent. Archive external
references only when their exact revision supports a material decision or future
reproducibility; routine parts do not require a local manual copy.

The initial handoff needs only:

- project identity, explicit objective, and exclusions;
- `NEW_PROJECT + FAST_PROTOTYPE` unless the user chose otherwise;
- verified fact that no prior project state was inherited;
- architecture-changing unknowns and current evidence state;
- one primary next decision and its success check.

Do not claim an active revision, passed gate, verified part, or authoritative EDA
artifact before this project produces the evidence.

## Keep artifact identity reproducible

For a reviewed baseline or order candidate record enough to pair source and
output reliably:

- revision/state, generation time, and timezone;
- source and export filenames, sizes, and SHA-256 hashes;
- EDA/tool version and applicable rule/configuration identity;
- board dimensions, layers, useful object counts, and drill summary;
- review result, accepted deviations, and evidence qualifier;
- order status and portal options/order number when an order actually occurs.

Never overwrite a reviewed candidate with a later export. Downloads are
transport locations; approved artifacts belong under the project root.

## Separate procurement identities

Keep distinct:

- electrical role/value;
- manufacturer part and approved substitution;
- symbol and physical footprint;
- geometry donor used only for a verified land pattern;
- stock record and evidence that the item is on hand;
- purchase action and quantity;
- EDA BOM/PCB inclusion flags.

A geometry donor is not a purchase recommendation. Referencing stock does not
reserve or deduct inventory. Buying, reserving, deducting, or changing an
external inventory system requires authorization for that action.

## Build the manufacturing package to the requested level

For PCB-only orders, include the matched Gerber/drill package and necessary fab
notes. For PCBA, additionally check the controlled BOM, substitutions, CPL side
and rotation, polarity/pin-1 drawing, DNP variants, fiducials/tooling assumptions,
sensor handling, and test/serial-label access as applicable.

Before payment, compare the fabricator's current preview/DFM result with the
archived candidate. A package can be `manufacturing-checked` for a prototype
without proving product or production readiness.
