# Action and EDA Provider development

Read this document only when changing the Action runner, Action manifest, an existing Provider, or implementing another EDA Provider.

Normal hardware design and ordinary EDA operation do not need it.

## System boundary

`SchematicContract` stores design intent that is independent of EDA.

An EDA Provider maps that intent to native libraries and part identity, pins and nets, document objects and geometry, plus writes, saves, and readback.

Action plans, snapshots, and reports are execution artifacts, not another project database. Stable intent remains in the project Contract and EDA source.

## Actions and workflows

`scripts/actions/manifest.json` registers executable Actions and workflows.

An Action is independently runnable and verifiable. A workflow only gives an order for existing Actions; it does not define another general workflow language.

An internal Action may be hidden from normal discovery but must remain registered, callable by exact name, explicit about input and output, and independently testable.

Do not register an unimplemented Provider, Action, or workflow.

## Add a Provider

A new Provider need not imitate EasyEDA internals, but it should support the real capabilities required by its workflow, including:

1. detect the environment and available capabilities;
2. map portable intent to native parts, pins, and document objects;
3. read actual document state;
4. apply a bounded edit to target objects;
5. read results back through native IDs or equivalent identity;
6. return success, unsupported, or unknown state explicitly.

Add a Provider to the public manifest only after it completes at least one real operation with corresponding tests. An empty directory, placeholder Adapter, or mock that always succeeds is not Provider support.

## Write transactions

When recovery has real value, use:

```text
inspect → plan → apply → verify
```

Before applying, confirm that the target document and related objects still match the plan. Read actual state again after manual edits, reopening, or a long interruption.

After writing, read the target objects directly and confirm both the requested increment and preservation of existing objects. Saving is separate and explicit. Do not claim rollback for an operation that cannot truly restore state.

Report completed, unsupported, unknown, actual blocker, and verified coverage separately.

## Temporary run files

One execution may use:

```text
.flitrealize/runs/<run-id>/
```

These files serve only the current transaction. Remove the run after completion and reconciliation when recovery is no longer needed. Move any durable design, evidence, or manufacturing artifact into the project's normal directories and reference it from `CURRENT_HANDOFF.md` or the owning stage artifact.

`.flitrealize/runs` must not be the only copy of stable design intent, EDA source, or validation evidence.

## Extend and maintain

Add an Action or workflow only when repeated work materially reduces errors or effort.

When changing an implementation:

1. start from a real failure or repeated need;
2. reduce it to a reproducible input;
3. change the smallest module that owns the behavior;
4. add a test that observes the real result;
5. retain explicit unsupported boundaries.

Value comes from reliable reuse, rejection of stale operations, and verified results, not from Action count.
