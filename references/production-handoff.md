# Project initialization, procurement, and manufacturing handoff

Read this reference for a new project root, inventory/procurement identity, or a
manufacturing/order candidate. Cross-chat state ownership lives in
[continuation.md](continuation.md).

## Initialize only an explicit new project

A concept discussion does not create files. When initialization is requested:

1. Use the exact destination supplied by the user or host. Ask one narrow
   location question only when multiple plausible targets remain. Protect any
   source project.
2. Choose a descriptive non-colliding child directory. Stop rather than merge
   into an existing directory that may contain work.
3. Create only the files needed now. Add `CURRENT_HANDOFF.md` only when work must
   continue across tasks, and add stage directories only when work reaches them;
   do not create empty placeholders.
4. Record only facts established by this project. A derived project may reuse
   methods or selected source material, but not the baseline project's state,
   decisions, or passed gates.

A useful structure can grow toward:

```text
project/
├── README.md
├── CURRENT_HANDOFF.md       # only when continuation is needed
├── design/
├── parts/
│   └── datasheets/
├── eda/
│   └── <provider>/
├── evidence/
└── .flitrealize/
    └── runs/
        └── <run-id>/
            ├── inputs/
            ├── bridge/
            └── reports/
```

Keep the root as the human entry surface. Stable requirements, architecture,
calculations, part decisions, tests, and the machine-readable Contract belong in
`design/`; the project BOM, inventory match, approved alternatives, and critical
datasheets belong in `parts/`; authoritative EDA sources and controlled exports
belong in `eda/<provider>/`; and only retained evidence referenced by current
project state belongs in `evidence/`.

`.flitrealize/runs/<run-id>/` is disposable working state for generated Action
inputs, provider bridge snippets, plans, Snapshots, and transient reports. It
must not own design intent, authoritative EDA source, or the only copy of durable
evidence. Keep a run until its transaction is reconciled and rollback is no
longer needed; then remove it unless a selected result is promoted to `evidence/`
and referenced by current state. Generic bridge servers and Action runners stay
with the Skill or Provider adapter, never in an individual project.

Create `mechanical/`, `firmware/`, `manufacturing/`, or project-specific
`automation/` only when that work actually exists. Avoid generic dumping grounds
such as `misc/`, `temp/`, `old/`, `backup/`, or `generated/`. Archive external
references only when their exact revision supports a material decision or future
reproducibility; routine parts do not require a local manual copy.

When continuation is needed, the initial handoff needs only:

- project identity, explicit objective, and exclusions;
- source relationship and the fact that prior project state was not inherited;
- current stage and architecture-changing unknowns;
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

## Declare shared inputs without copying them

When a project depends on a workspace inventory or other shared catalog, record
its resolved paths in `CURRENT_HANDOFF.md` under `## Shared inputs`; do not
hard-code workspace-specific paths in this Skill or the portable Contract. For
an inventory, distinguish:

- the source-of-truth workbook or database;
- the AI-readable catalog used for part matching;
- the quantity snapshot, when it is a separate artifact;
- the refresh command that derives readable files; and
- the allowed access, which defaults to read-only unless the user authorizes an
  external write.

Read the declared AI-readable catalog before final part selection or procurement
matching. If it is missing, inaccessible, or older than its source of truth,
leave the match unresolved and refresh it only when that command is within the
current writable scope. Do not copy the whole shared inventory into the project.
Store only the project-specific result, normally `parts/inventory-match.csv`,
with enough source identity or timestamp to detect staleness.

Referencing shared inventory does not reserve, deduct, buy, or edit stock. Those
are external state changes and require explicit authorization.

## Separate procurement identities

Keep distinct:

- electrical role/value;
- manufacturer part and approved substitution;
- symbol and physical footprint;
- geometry donor used only for a verified land pattern;
- stock record and evidence that the item is on hand;
- purchase action and quantity;
- EDA BOM/PCB inclusion flags.

A geometry donor is not a purchase recommendation. Buying, reserving, deducting,
or changing an external inventory system requires authorization for that action.

## Build the manufacturing package to the requested level

For PCB-only orders, include the matched Gerber/drill package and necessary fab
notes. For PCBA, additionally check the controlled BOM, substitutions, CPL side
and rotation, polarity/pin-1 drawing, DNP variants, fiducials/tooling assumptions,
sensor handling, and test/serial-label access as applicable.

Before payment, compare the fabricator's current preview/DFM result with the
archived candidate. A package can be `manufacturing-checked` for a prototype
without proving product or production readiness.
