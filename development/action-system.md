# Action and EDA Provider development

Read this document only when changing the Action runner, Action manifest, an existing Provider, or implementing a new EDA Provider.

Ordinary hardware design and normal EDA operation do not need it.

## System boundary

`SchematicContract` stores design intent that is independent of a specific EDA.

An EDA Provider maps that intent into the target EDA's library and part identity, pins and nets, document objects and geometry, and write, save, and readback results.

Action plans, snapshots, and reports are execution artifacts, not a project database.

Stable results belong in:

- the Contract or corresponding machine artifact;
- EDA source;
- manufacturing or test artifacts;
- the corresponding human-readable section of `CURRENT_HANDOFF.md`.

## Actions and Workflows

`scripts/actions/manifest.json` registers executable Actions and Workflows.

An Action is an operation that can run and be verified independently.

A Workflow describes the order of existing Actions. It does not create another general workflow language.

An internal Action may be hidden from ordinary discovery, but it still has:

- a manifest registration;
- an exact callable name;
- explicit input and output;
- independent tests.

Register only implemented Providers, Actions, and Workflows.

## Add a Provider

A new EDA Provider does not need to imitate EasyEDA internally, but it should support the capabilities required by its workflow:

1. Detect the current environment and capabilities.
2. Map portable design into native parts, pins, and document objects.
3. Read actual document state.
4. Make bounded changes to target objects.
5. Read back results by native ID or equivalent identity.
6. Return success, unsupported, or unknown state explicitly.

Add a Provider to the public manifest after at least one real operation and its corresponding tests exist.

## Write transactions

When recovery has practical value, use:

```text
inspect -> plan -> apply -> verify
```

Before execution, confirm the target document and related objects still match the plan. Read actual state again after manual edits, reopening the document, or a long interruption.

After a write, read back the target objects to confirm the requested increment and check that existing objects were not overwritten unexpectedly.

Saving is a separate operation. Do not claim rollback for an operation that cannot actually be restored.

## Temporary run files

Inputs, Bridge fragments, and reports from one execution may live under:

```text
.flitrealize/runs/<run-id>/
```

They serve only the current transaction. Delete the run after execution completes and recovery is no longer needed.

Stable design, EDA source, and retained validation evidence belong in the project's normal directories. Synchronize results that affect project judgment into the corresponding section of `CURRENT_HANDOFF.md`.

`.flitrealize/runs` never owns the only copy of a stable artifact.

## Extension and maintenance

Add an Action or Workflow only when the repeated operation materially reduces errors or work.

When changing an implementation:

1. Ground the problem in a real failure or repeated need.
2. Reduce it to reproducible input.
3. Change the smallest module that owns the behavior.
4. Add a test that observes the actual result.
5. Preserve the remaining unsupported scope.

The system's value comes from reliable reuse, rejection of stale operations, and verification of real results, not from Action count.
