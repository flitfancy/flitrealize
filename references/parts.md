# Portable part resolution

Read this reference when converting circuit intent into candidate or approved
parts, matching a declared inventory, or preparing sourcing identities. This
stage is portable and must not depend on EasyEDA or another EDA library.

## Keep one clear boundary

```text
AI design judgment
    -> structured part intent
    -> inventory and trusted-source resolution
    -> candidate or approved parts
    -> optional EDA binding
```

AI owns electrical intent, constraints, architecture context, and final
judgment. Deterministic tooling owns normalization, exact search, filtering,
ranking, download, hashing, caching, and output generation.

Keep separate:

- electrical role and constraints;
- exact manufacturer and MPN;
- distributor or inventory identity;
- datasheet source and revision;
- symbol and footprint identity; and
- Provider-specific EDA binding.

A valid sourcing result does not prove an EDA binding, and an EDA library result
does not prove procurement identity.

## Planned resolver boundary

The reserved implementation location is `scripts/parts/parts-resolver.mjs`.
It is intentionally not registered as a public Action yet. Until its schema,
source adapters, outputs, and tests are implemented, do not claim that automated
part resolution is available.

The planned public resolver will accept structured part intent and produce
project-scoped results such as candidate parts, approved identities, purchase
gaps, and a datasheet manifest. It may read a user-declared inventory but must
not reserve, deduct, purchase, or modify stock without explicit authorization.

## Work before automation exists

Use reliable current manufacturer or official distributor information directly.
One reliable source is enough unless identity is missing or sources conflict.
Return exact matches separately from candidates and unresolved questions. Send
only the affected uncertain decision into CURIOUS_MODE.

Read [production-handoff.md](production-handoff.md) for shared inventory and
procurement-state handling. Read
[schematic-contract.md](schematic-contract.md) when approved part decisions must
enter a machine-readable schematic Contract.
