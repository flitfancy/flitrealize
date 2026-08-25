# Focused hardware fault loop

Use this reference when one subsystem conclusion is changing across repeated
focused experiments. It does not expand writable scope or change project intent.

## Decide whether a battle log is useful

Do not create one for ordinary implementation, a single understood failure, or
completed work. For an active unstable subsystem, keep one `BATTLE_LOG.md` with:

```markdown
# Active subsystem and boundary
# Current hypothesis or conclusion
# Direct evidence
# Next experiment, expected result, and stop condition
```

Read `CURRENT_HANDOFF.md` first. The handoff owns project identity and stable
state; the battle log temporarily owns only its named subsystem.

## Run the smallest discriminating experiment

Order evidence by cost: existing first-party failure, minimal probe, then
inference.

1. Read the active conclusion, latest direct evidence, and only the source or
   configuration needed for this fault.
2. State one leading hypothesis and the observation that separates it from the
   remaining plausible alternatives.
3. Make the smallest authorized local change or probe.
4. Run a targeted red/green check and capture its raw result.
5. Update the conclusion and next experiment briefly.

Do not rerun full BOM, inventory, netlist, layout, ERC, or DRC sweeps while the
affected boundary is unchanged. Broaden when evidence crosses that boundary or
a stable milestone needs regression coverage.

For user-operated EDA retries, provide one current script, required active
document, expected visible result, and stop condition rather than several
experimental variants.

## Stop accumulating patches

After a failure, use the new evidence before changing another assumption. When
materially similar attempts repeat without discriminating evidence, pause and
build a minimal reproducer, shared invariant, or human observation instead of
continuing variant churn. The exact stopping point should reflect risk and cost,
not an arbitrary attempt count.

For live EDA, use the transaction and rollback contract in
[easyeda-pro.md](easyeda-pro.md). Diagnose, apply, and verify should share the
same decision/geometry core when practical.

## Exit cleanly

When the conclusion stabilizes, merge the evidence-linked result into
`CURRENT_HANDOFF.md`, then archive or remove the battle log within authorized
scope. Leave one current entrypoint per action and mark obsolete experiments
historical or unsafe.

Record a reusable-method candidate only when the experiment produced realistic
green and red evidence. Promotion rules remain owned by the knowledge catalog,
not this local fault log.
