# Reusable local Actions and provider boundaries

Read this reference when changing the Action runner or manifest, promoting a
repeated operation into an Action, or implementing a real EDA provider. Do not
load it for ordinary one-off analysis.

## Keep one portable boundary

- `SchematicContract` owns portable design intent.
- `schematic-contract-audit` is the boundary check before provider work.
- A provider owns library identity, live geometry, mutation, and readback.
- A Snapshot records realized state; a report records execution evidence.
- Neither a generated plan nor a report becomes a second project database.

The normal schematic surface is deliberately small:

```text
Contract Audit -> Components -> Connect -> Finalize
```

`Contract Audit` is a public host Action. The other three entries are public
workflow descriptions backed by internal fine-grained Actions. The runner does
not execute a workflow as a new general-purpose engine; the Skill follows its
declared phases and passes each result to the next Action.

## Register public workflows and internal Actions

`scripts/actions/manifest.json` is the registry. Its flat `actions` object keeps
stable exact lookup names. An Action declares `contractVersion`, `domain`,
`runtime`, supported `providers`, modes, and mutation state. `internal: true`
hides implementation Actions from normal discovery without making them
unregistered or untestable.

The `workflows` object is discovery and orchestration metadata. Each workflow
names one tested Provider and ordered phase steps such as `prepare`, `apply`,
`verify`, and `rollback`. Manifest loading rejects unknown Actions, modes,
Providers, domain mismatches, and invalid optional steps.

`action-runner.mjs list` returns public Actions, public workflows,
`actionGroups`, and `workflowGroups`; `list --domain schematic` filters both
surfaces. An internal Action may still be run by exact name for workflow
orchestration, debugging, and regression tests. Mutation authorization remains
enforced per Action.

## Keep Provider code concrete

Host Actions live in `scripts/actions/`. EasyEDA code lives in
`scripts/actions/easyeda-pro/`. A manifest file path is exact and relative to
`scripts/actions/`; the older provider-relative basename fallback remains only
for compatibility.

Do not add empty KiCad, Altium, or other Provider directories as architecture.
Add a Provider only with a working Adapter boundary, a capability probe, at
least one implemented Action, mock regression coverage, and a bounded live
checkpoint. A new Provider implements the same portable Contract boundary and
workflow outcome; it does not need to imitate EasyEDA primitives internally.

This keeps extension work small:

1. map portable intent to native library/component/pin identity;
2. capture native document state into the shared Snapshot boundary;
3. implement bounded native mutations with ID-based readback;
4. register only the tested Actions and workflows; and
5. preserve unknown and unsupported coverage instead of returning empty success.

There is no provider-to-file abstraction until two real Providers demonstrate
that it is needed.

## Keep internal artifacts proportional

Use a versioned shared schema only when the artifact crosses a meaningful
boundary or is consumed by more than one independent subsystem. The Contract,
PlacementPlan, and Snapshot meet that bar. EasyEDA connection planning is an
internal transient result, so it keeps a versioned Action result shape without
being promoted to a public JSON Schema. Provider binding resolution likewise
returns an ephemeral `providerBindings` map; the selected binding may be cached
under `contract.components[].bindings.<provider>` when the project chooses to
persist it, but no separate BindingSet database is required.

## Keep runs disposable

Put run-scoped working files under one transaction directory:

```text
.flitrealize/runs/<run-id>/
├── inputs/
├── bridge/
└── reports/
```

Use `inputs/` for requests, Contracts copied for execution, and plans; `bridge/`
for generated provider code or command snippets; and `reports/` for transient
inspect/apply/verify results, Snapshots, and coverage reports. Generic bridge
infrastructure, the Action runner, and reusable provider logic remain in the
Skill or adapter rather than being copied into each project.

Keep the run while a mutation is pending, verification is incomplete, or
rollback data may still be needed. After successful reconciliation, remove the
whole run; remove an ordinary abandoned failure as well. Retain a repeated
active-fault run only while `BATTLE_LOG.md` references it. Promote only selected
durable evidence into `evidence/` and reference it from current project state.
Deleting `.flitrealize/` must never erase stable design intent, authoritative
EDA source, or the only copy of retained evidence.

## Preserve transaction safety

Provider writes remain plan/apply/verify/rollback transactions where rollback
is meaningful. Bind plans to the selected document and relevant contract,
binding, capability, Snapshot, and geometry fingerprints. Re-inspect after
manual edits or timeouts. Verify the requested delta through created native IDs
and protect pre-existing IDs; global enumeration is coverage evidence, not a
substitute for targeted readback.

Save is explicit and has no fake rollback. Report `unsupported`, `unknown`,
blockers, and coverage separately. `PASS` proves only the declared checked
scope.

## Evolve from evidence

Promote repeated logic only when it reduces error or substantial repeated work.
For a real failure, classify it, reduce it to a sanitized fixture, add a
regression, change the smallest owning rule, and document the remaining
unsupported scope. Measure value through reliable reuse, stale-plan rejection,
coverage, and verified recovery—not Action count.
