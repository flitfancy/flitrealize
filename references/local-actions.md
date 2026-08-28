# Reusable local Actions and provider boundaries

Read this reference when repeated project work should become a deterministic
Action, when changing the Action runner or manifest, or when adding an EDA
provider. Do not load it for ordinary one-off analysis.

## Keep one project truth with separate responsibilities

- The project contract owns design intent.
- A source artifact or structured Snapshot records the realized state.
- An Action input owns one bounded requested operation.
- An Action report is execution evidence, not a second project database.
- `CURRENT_HANDOFF.md` records the current conclusion and next action after the
  evidence is interpreted.

Do not let generated reports silently redefine design intent. A changed intent
updates its owning contract before a dependent write is reused.

## Register the execution contract

`scripts/actions/manifest.json` is the single public registry. Manifest schema
2 gives every Action:

- `contractVersion`: the input/output contract revision;
- `domain`: the hardware or system area it serves;
- `runtime`: `host` for deterministic local computation or `eda` for a live EDA
  operation; and
- `providers`: the exact tested EDA providers, empty for a host Action.

The runner infers a Provider only when an EDA Action declares exactly one.
Otherwise require an explicit Provider. Reject an unregistered or
Action-incompatible Provider before execution. Only providers with an actual
tested adapter belong in the registry; empty vendor directories and claims of
future support do not.

Host Actions execute locally from structured input and do not cross the EDA
Bridge. EDA Actions execute through the selected host Adapter and retain the
live-write lock. Both runtimes use the same mode/mutation authorization,
compact summary, and host-local full report envelope.

The provider-free `schematic-contract-audit` is the first Host Action. It
validates portable design intent without importing an EDA API or claiming that
the realized schematic matches.

## Lay out Actions by provider subdirectory

EDA Action files live under `scripts/actions/<provider>/`. Host Actions stay
in the `scripts/actions/` root. The runner resolves the file path declared in
the manifest, checking the provider subdirectory first when a Provider is
active:

```text
scripts/actions/
  manifest.json                  ← single public registry
  schematic-contract-audit.js    ← host Action (provider-free)
  easyeda-pro/                   ← EasyEDA Pro EDA Actions
    eda-capabilities.js
    pcb-ground-vias.js
    schematic-inspect.js
    ...
  kicad/                         ← future provider (example template)
    README.md
  altium/                        ← future provider (example template)
    README.md
```

To add a new EDA provider:

1. Create `scripts/actions/<provider-id>/` with an `eda-capabilities.js` that
   probes the new EDA's API surface.
2. Register the provider and its Actions in `manifest.json`.
3. Register the adapter root with `eda-host.mjs register --eda <provider-id>
   --adapter-root <path>`.
4. Write tests in `tests/<action-name>.test.mjs` using mock EDA objects.
5. Only add the provider to the registry after at least one Action passes
   its test with a live EDA connection.

## Make outputs useful without hiding coverage

Default output should contain the Action identity, contract version, domain,
runtime, Provider, mode, mutation state, document identity when applicable,
fingerprints, useful counts, issue count, and whether a next or rollback request
exists. Keep the complete response in the local report.

Report `unsupported`, `unknown`, blockers, and relevant coverage separately.
`PASS` proves only the declared checked scope. Do not treat a missing API object
or unrecognized primitive as an empty design.

Use versioned Snapshot and Patch formats when multiple Actions share realized
state or authorized deltas. Keep provider-native IDs opaque and place provider
extensions under a namespaced field rather than leaking them into portable
decision rules.

## Evolve from evidence, not accumulation

Promote a repeated operation into an Action when deterministic execution
improves reliability or avoids repeated substantial model work. After a real
failure or unknown case:

1. classify it as input error, rule gap, provider drift, unsupported geometry,
   or a design decision;
2. reduce it to a sanitized fixture when practical;
3. add a regression that fails for the observed reason;
4. change the smallest owning rule, Action, or Adapter;
5. rerun old positive, negative, boundary, and rollback cases; and
6. publish the behavior and remaining unsupported scope.

A single project-specific method remains a candidate unless authoritative
evidence or a materially different project supports promotion. Never let a
local Action rewrite its own reusable rules from one run. It may report a rule
candidate for review.

## Detect staleness and fail closed

Bind reusable plans to the relevant contract, Snapshot, document, Adapter, and
capability fingerprints. Invalidate them after a manual source change,
different selected document, Provider/API change, or required-capability
failure. Verify the expected delta and protected invariants after a write; stop
with exact unsupported evidence when readback cannot prove the result.

Measure value through reduced raw-to-summary size, cache or delta reuse,
coverage, false positives, unsupported counts, zero unauthorized changes, and
verified rollback—not through Action count alone.
