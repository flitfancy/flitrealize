# EDA Provider selection

Read this reference only when the user requests EDA work or a Provider-specific
artifact. Portable requirements, part decisions, and schematic intent do not
need an EDA Provider.

## Select without scanning every Provider

1. If the user names an EDA, use that Provider when it is implemented.
2. If the current project already has an authoritative EDA source, continue with
   that Provider unless the user requests migration.
3. If the user requests only portable design or sourcing output, stop before EDA.
4. If EDA work is requested without a named or existing Provider, inspect the
   registered Provider catalog. Use a single active supported Provider; ask only
   when multiple plausible choices would materially change the result.

After selection, read only the Provider index and workflow for the current
operation. Query registered public Actions for the current domain instead of
scanning implementation scripts.

## Implemented Providers

- EasyEDA Pro: [easyeda-pro.md](easyeda-pro.md)

Do not create placeholder Provider directories or claim support before a real
adapter, capability probe, implemented Action, test coverage, and bounded live
checkpoint exist.
