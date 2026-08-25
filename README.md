# FlitRealize

[简体中文](README.zh-CN.md)

FlitRealize is an electronics hardware engineering skill that advances a
stateful project from requirements and architecture through schematic, PCB,
prototype ordering, bring-up, and evidence-driven revision.

> Status: `v1.0.0-rc.1` public-release candidate. The workflow is being prepared
> for clean-environment testing before a stable release.

## Scope

FlitRealize is for project-level electronics hardware work, including:

- requirements, architecture, parts, and schematic decisions;
- PCB placement, routing intent, manufacturing review, and EDA automation;
- prototype ordering, safe bring-up, debugging, and revision;
- project-isolated continuation across conversations.

It is not a general software, website, content-creation, or project-management
skill. It also avoids activating for isolated component facts or one-step EDA
questions that need no project state.

## Compatibility

The skill follows the open Agent Skills structure and is tested primarily with
Codex. A host with only chat or read-only tools can still plan and review, while
file, terminal, browser, and EDA tools are required for corresponding actions.
Optional local knowledge catalogs improve continuity but are never required.

## Install for local Codex use

Place this repository at:

```text
$HOME/.agents/skills/flitrealize
```

Or ask `$skill-installer` to install the skill from the repository URL after the
GitHub remote is published. Invoke it explicitly with `$flitrealize`; Codex may
also select it when a request matches the description. Restart Codex if a newly
installed or renamed skill does not appear.

See the [official OpenAI skill documentation](https://developers.openai.com/codex/skills)
for current discovery and installation behavior. Standalone skills are intended
for local use and experimentation; wider installable distribution can later use
a plugin.

## Repository layout

```text
flitrealize/
├── SKILL.md                 # runtime entrypoint
├── agents/openai.yaml       # Codex UI metadata
├── references/              # runtime references loaded on demand
├── docs/zh-CN/              # human-readable Chinese mirror
├── scripts/                 # deterministic validation and packaging
└── .github/workflows/       # repository validation
```

Only `SKILL.md`, `agents/`, and `references/` enter the release ZIP. Author
workspaces, project records, local catalogs, and optimization history are not
part of the public artifact.

## Validate and package

```powershell
python scripts/validate.py
python scripts/package_release.py
```

The package command creates a deterministic ZIP and SHA-256 sidecar under
`dist/`. If an English instruction changes, update the matching Chinese text and
then refresh its source hash with:

```powershell
python scripts/update_translation_hashes.py
```

## License

A public license has not been selected yet. Add an explicit `LICENSE` before
publishing the repository or release archive.
