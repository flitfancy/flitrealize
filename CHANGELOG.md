# Changelog

All notable changes to FlitRealize will be recorded here.

## [Unreleased]

## [1.0.0-test.2] - 2026-09-01

This release simplifies FlitRealize around the hardware work the user actually
requested. The main Skill now owns the whole-flow route and shared behavior,
while numbered references own the details of each stage.

### Added

- Added a numbered reference map from project continuation and requirements
  through schematic, PCB, manufacturing, prototype validation, and formal
  release.
- Added a lightweight parts resolver that checks a shared local database first,
  retrieves missing LCSC product metadata and PDFs when available, records a
  small manifest, and returns a focused lookup request when an exact source
  cannot be resolved automatically.
- Added a requirements-and-architecture reference and a maintainer-only Action
  system note so runtime guidance and implementation details remain separate.

### Changed

- Rewrote the main Skill around direct `DEFAULT_MODE` execution and local
  `CURIOUS_MODE` investigation without adding project-wide gates or reports.
- Reorganized and rewrote the English references and Chinese review mirrors by
  hardware stage, with shorter routing and clearer ownership between design,
  EDA, manufacturing, and validation.
- Simplified project continuation, debugging, evidence, and authorization rules
  so ordinary in-scope work can continue without ceremonial state management.
- Clarified the PCB sequence as two passes through physical foundation: establish
  layers, outline, and keepouts before layout; then rebuild and confirm reference
  copper before grounding and final review.
- Kept part selection and schematic intent portable while routing EasyEDA Pro
  work only through the relevant Provider reference.
- Updated the public README and Skill metadata to match the new workflow and
  package layout.

### Removed

- Removed the old unnumbered reference set and duplicated Action-system details
  from the runtime path.
- Removed broad requirements for lifecycle paperwork, repeated evidence labels,
  and extra state files during ordinary prototype work.

### Validation status

- Repository validation, Node Action tests, Python release tests, deterministic
  packaging, and clean-archive smoke tests are part of the release workflow.
- Real hardware behavior and live end-to-end EDA use remain practical test work
  for this prerelease; this release does not claim physical prototype validation.

## [1.0.0-test.1] - 2026-08-31

### Added

- Added the versioned `SchematicPlacementPlan v1` schema and internal
  connection-planning Action.
- Added provider pin maps and evidence-bearing EasyEDA library candidate
  resolution so semantic Contract pins can map to one or more native pins.
- Added public EasyEDA schematic `Components`, `Connect`, and `Finalize`
  workflow metadata backed by internal fine-grained Actions.
- Added regressions for schematic wire creation, net flags, save/DRC
  separation, live pin capture, binding resolution, wire-plan staleness, and
  PCB component geometry.

### Changed

- `schematic-layout` now emits requested placement intent instead of a fake
  provider Snapshot; `schematic-component-place` consumes it directly and
  enforces/readbacks designators.
- `schematic-layout` now uses the Contract block order, per-component symbol
  geometry, per-anchor clusters, connector directions, block bounding boxes,
  routing-lane gaps, grid snapping, and overlap diagnostics.
- `schematic-inspect` now emits a live `SchematicSnapshot v1` with component,
  pin, wire, coverage, and semantic fingerprint evidence.
- `schematic-resolve-bindings` now separates candidate search from resolution,
  consumes the Contract directly, auto-selects only a unique strict exact
  match, preserves unresolved blockers, and returns ephemeral provider bindings.
- Wire, net-flag, and save flows now use explicit plan/apply/verify transaction
  boundaries, document identity, semantic staleness checks, and readback-backed
  rollback where applicable.
- Schematic write Actions now use a common nested `request` transaction envelope
  while retaining legacy top-level input compatibility.
- Action discovery now shows public workflows and hides internal implementation
  Actions while preserving exact Action lookup for orchestration and tests.
- EDA subprocess deadlines now derive from
  `FLITREALIZE_EDA_ACTION_TIMEOUT_MS`; a newly started EasyEDA bridge inherits
  the same bounded request timeout unless explicitly configured otherwise.

### Fixed

- Use EasyEDA's flat wire polyline input and verify points/style on readback.
- Verify created and deleted wires with `sch_PrimitiveWire.get(id/get(ids))` in
  bounded batches; `getAll()` is now coverage evidence rather than the target
  success condition.
- Avoid duplicate endpoint stubs by comparing a live Snapshot's existing wire
  segments with a bounded point-to-polyline tolerance; block ambiguous or
  conflicting existing connectivity.
- Component placement now uses fallback provider identity fields, tolerates
  insignificant coordinate readback noise, and reports provider identity as
  unknown instead of falsely claiming it was verified.
- `schematic-save-verify` no longer saves in read-only `verify` mode.
- Net-flag rollback no longer assumes zero remaining primitives without
  querying the document.
- Cleared the PCB bounding-box timeout after a prompt API response.

### Removed

- Removed the public WirePlan JSON schema and the unnecessary separate
  BindingSet concept; both are transient EasyEDA workflow details.
- Removed empty KiCad and Altium template directories. Providers are now added
  only with a concrete Adapter, implementation, regression, and live checkpoint.

## [0.1.0-test.10] - 2026-08-28

Schematic EDA Actions and multi-provider architecture. FlitRealize can now
place components, draw wires, add power symbols, and run DRC inside a live
EasyEDA Pro schematic. New EDA backends can be added by dropping Action files
into a provider subdirectory without modifying any framework code.

### Changed

- Moved all EDA Action files into provider subdirectories under
  `scripts/actions/<provider>/`. Host Actions remain in the `scripts/actions/`
  root. The runner resolves paths by checking the provider subdirectory first,
  then falling back to the root. This is fully backward-compatible.
- `action-runner.mjs`: `resolveActionFile()` now accepts an optional `provider`
  parameter for subdirectory-aware file resolution.
- `action-harness.mjs`: `loadAction()` now accepts an optional `provider`
  parameter for test-time subdirectory loading.
- All existing EDA tests updated to pass `'easyeda-pro'` as the provider.

### Added

- Five new EasyEDA Pro schematic Actions:
  - `schematic-inspect`: read-only capture of components, wires, nets, and
    document identity.
  - `schematic-component-place`: inspect/plan/apply/verify/rollback for
    schematic component placement.
  - `schematic-wire-create`: inspect/plan/apply/verify/rollback for schematic
    wire creation.
  - `schematic-net-flag`: inspect/apply/verify/rollback for net flags and net
    ports (power symbols, directional ports).
  - `schematic-save-verify`: inspect/verify for schematic save and DRC.
- `eda-capabilities.js` now probes `sch.*` API surface alongside `pcb.*`.
- `references/providers/easyeda-pro/schematic-workflow.md`: workflow guide for
  schematic Actions.
- `scripts/actions/kicad/` and `scripts/actions/altium/`: example provider
  directories with README templates showing how to add a new EDA backend.
- `references/local-actions.md`: documented the provider subdirectory layout
  and the steps to add a new provider.
- Tests for `schematic-inspect` and `schematic-component-place` (mock-based).

### Architecture

- Provider subdirectory pattern enables clean multi-EDA support: each provider
  owns its Action files, the manifest declares which providers each Action
  supports, and the runner routes automatically. No framework code changes
  needed when adding a new provider.

### Fixed

- Updated validation and deterministic release packaging to traverse Provider
  Action subdirectories and verify every manifest Action is present in the ZIP.
- Synchronized the Chinese mirrors and public version markers for this release.

## [0.1.0-test.9] - 2026-08-28

Cross-platform reproducible release packaging. Fixed Windows/Linux ZIP
byte differences and added golden-digest regression.

### Fixed

- Made release ZIP bytes reproducible across Windows and Linux by storing
  entries without platform-dependent Deflate output and normalizing ZIP order,
  timestamps, creator metadata, permissions, comments, and extra fields.
- Let check-only validation recognize the current published tag as a valid
  ancestor during subsequent development, while publish preflight continues to
  reject any attempt to reuse that tag.

### Verified

- Added a fixed-input golden-digest regression that also checks archive entry
  order, metadata, storage mode, and executable permissions on every supported
  CI platform.

## [0.1.0-test.8] - 2026-08-28

EasyEDA Pro provider workflow reorganization. Split guidance into separate
references for PCB foundation, grounding, and environment.

### Changed

- Reorganized EasyEDA Pro guidance around the actual execution flow: Provider
  boundaries, host environment, PCB foundation, and PCB grounding now have
  distinct English/Chinese references with direct routing from `SKILL.md`.
- Made runtime packaging, translation pairing, source-hash refresh, and
  reference-discovery validation recurse through Provider subdirectories so
  future EDA integrations can follow the same structure.

## [0.1.0-test.7] - 2026-08-27

Schematic contract system and host Action runtime. Introduced
`SchematicContract v1` schema, `SchematicSnapshot v1` schema, and the
first provider-free Action (`schematic-contract-audit`) for offline design
intent validation.

### Added

- Added Manifest schema 2 metadata for Action contract version, domain,
  execution runtime, and exact tested Providers without claiming unimplemented
  EDA support.
- Added a deterministic host Action runtime beside the existing EDA runtime so
  future offline contract audits can reuse the same authorization, summary, and
  evidence-report envelope without crossing the Bridge.
- Added a routed English/Chinese reference for project-truth ownership,
  Snapshot/Patch boundaries, fixture-led evolution, and fail-closed staleness.
- Added strict, versioned `SchematicContract v1` and `SchematicSnapshot v1`
  machine schemas with Provider-native identities isolated in namespaced
  bindings or extensions.
- Added the first provider-free Host Action, `schematic-contract-audit`, for
  deterministic structure, identity, reference, evidence-state, pin/net, and
  NC/DNC checks without connecting to an EDA.

### Changed

- Made the host adapter allowlist derive from the registered Provider catalog
  and kept EasyEDA Pro as the only current tested Provider.
- Expanded compact Action summaries and local reports with contract, domain,
  runtime, Provider, unsupported, unknown, and blocker metadata.
- Included machine schemas in deterministic runtime packaging and clean-ZIP
  byte verification.

### Verified

- Preserved all existing PCB Action behavior and mutation authorization tests;
  added regressions for Provider rejection, host runtime execution, and compact
  unsupported-coverage counts.
- Added six schematic-contract fixtures covering valid portable intent, opaque
  EasyEDA binding, unresolved conditional evidence, duplicate designators,
  broken endpoint references, and a connected no-connect pin; the clean ZIP
  smoke test now executes the packaged Host audit end to end.

## [0.1.0-test.6] - 2026-08-27

Release infrastructure and quick-start documentation. Added GitHub Release
workflow, English/Chinese quick starts, and runtime architecture diagrams.

### Added

- Added a minimal private `package.json` that declares Node.js 22 or newer and
  exposes the canonical cross-platform Node test entrypoint without duplicating
  the release version.
- Added deterministic CHANGELOG-section extraction and a tag-triggered GitHub
  Release workflow that rebuilds, verifies, drafts, uploads, and then publishes
  the ZIP and SHA-256 sidecar with repository-scoped credentials.
- Added English and Chinese quick starts, a runtime architecture diagram, and a
  one-line routing map for all nine on-demand hardware references.

### Changed

- Expanded repository validation to Ubuntu with Node.js 22 and 24 plus Windows
  with Node.js 24, while keeping deterministic artifact construction in one
  bounded job.
- Made committed-range secret scanning shell-neutral by resolving GitHub push
  and pull-request revisions inside Python instead of workflow shell syntax.
- Made GitHub Release retries fail closed when an already-published asset differs
  from the newly rebuilt deterministic artifact.
- Updated the authorized PowerShell publish path so its atomic tag push hands
  release publication to the independently verified GitHub workflow.

### Verified

- Expanded mutation-authorization coverage to every registered Action mode and
  added a Windows-safe report filename regression.
- Expanded release-tool coverage from five to nine tests, including GitHub push
  and pull-request event parsing plus exact CHANGELOG section extraction.

## [0.1.0-test.5] - 2026-08-27

Action framework foundation. Established the versioned Action registry,
unified runner, EasyEDA capability probe, write authorization, and compact
report envelope.

### Added

- Added the MIT License under Copyright (c) 2026 FlitFancy and included it in
  the runtime release archive.
- Added a versioned machine-readable Action registry and a read-only EasyEDA
  capability probe.
- Added a unified Action runner that enforces registered modes, blocks live
  writes without an explicit write switch, prints compact summaries, and keeps
  full responses in host-local reports.
- Added one cross-platform Node test entrypoint and shared Action-loading test
  harness.
- Added a check-only PowerShell release entrypoint plus reusable version,
  clean-ZIP smoke, and staged-secret checks; publishing remains a separate
  user-authorized action.
- Included the canonical `VERSION` inside the runtime ZIP and compact Action
  summaries so an installed artifact can identify its own release.

### Changed

- GitHub Actions now runs the complete Node Action regression suite before
  building the release archive.
- Release validation now proves that every portable Action is registered with a
  valid default mode and mutation classification.
- Added an explicit, authorization-gated publish mode that commits only an
  already-reviewed staged set, rejects dirty remainder files and tag conflicts,
  and atomically pushes the release commit and tag.
- Hardened GitHub Actions with immutable Action revisions, bounded concurrency,
  strict license checking, main/tag/PR routing, and committed-range secret
  scanning instead of an empty staged-index scan.

## [0.1.0-test.4] - 2026-08-26

GND via edge-fence algorithm improvement. Replaced fixed-order selection
with cumulative-perimeter sampling for better board-edge coverage.

### Changed

- Replaced fixed-order edge-fence selection with cumulative-perimeter sampling,
  equal-perimeter coverage bins, and deterministic farthest-point gap reduction.
- Added bounded four-times edge candidate oversampling by default so blocked
  nominal samples can be replaced without weakening geometry filters.
- Count nearby existing GND vias as edge-coverage seeds and stop adding new
  edge vias when no remaining candidate reduces the combined maximum cyclic gap.
- Report existing/new occupied bins and before/after maximum perimeter gaps;
  added live FireFly Audio read-only validation and deterministic coverage tests.

## [0.1.0-test.3] - 2026-08-26

Grounding closure workflow. Added the three-stage grounding flow (reference
copper, return paths, global stitching) and the read-only stitching planner.

### Added

- Defined a three-stage grounding closure flow: establish realized reference
  copper, close necessary return paths, then optionally optimize global
  stitching after routing is stable.
- Added the read-only `pcb-ground-stitching.js` planner with bounded
  `signal-transition-return`, `edge-fence`, and `plane-grid` strategies.
- Added geometry-backed filtering for board edges, Regions, pads, tracks, arcs,
  existing vias, candidate spacing, and redundant nearby GND vias.

### Changed

- Preserved strategy, score, anchor, and rationale metadata through the existing
  `pcb-ground-vias.js` plan/apply transaction without duplicating its write and
  rollback logic.
- Documented the same three-stage flow in the English execution references and
  Chinese mirrors.

### Verified

- Added an end-to-end simulated four-layer test from grounding inspection,
  through stitching generation, into the existing via dry-run transaction.
- Verified that missing realized GND copper blocks generation; all six EasyEDA
  action test suites pass. The new board-wide planner still requires a bounded
  live-board checkpoint before promotion beyond T1 test status.

## [0.1.0-test.2] - 2026-08-26

GND via edge-case fixes. Resolved circular-keepout clearance, coordinate
roundoff, and candidate collision issues.

### Fixed

- Added an exact circular-keepout clearance fallback for EasyEDA environments
  where polygon discretization is unavailable.
- Tolerated sub-micro-mil coordinate roundoff during created-via readback while
  preserving strict identity and dimension checks.
- Prevented unused candidate alternatives from blocking one another before the
  final collision-safe via plan is selected.

### Verified

- Added regressions for circular keepouts, floating-point readback, and tight
  alternative selection; all five EasyEDA action test suites pass.
- Rebuilt the runtime archive so the packaged GND-via action matches the tested
  repository source.

## [0.1.0-test.1] - 2026-08-25

Public skill establishment. Renamed to `flitrealize`, removed private paths,
added EDA adapter registration, layer planning, grounding inspection, and
the first seven EasyEDA PCB Actions.

### Changed

- Established the public skill and invocation name as `flitrealize`.
- Removed author-specific absolute paths and private catalog method identifiers.
- Made workspace-local knowledge catalogs optional rather than required.
- Moved the Chinese mirror into the repository under `docs/zh-CN`.

### Added

- Repository-level validation, translation hash synchronization, deterministic
  release packaging, and GitHub Actions validation.
- English and Chinese repository documentation.
- Host-local EDA adapter registration and session-aware Bridge startup through
  the portable `scripts/eda-host.mjs` runtime helper.
- Design-driven copper-layer planning and a recoverable EasyEDA layer-structure
  action without imposing a fixed layer count.
- Separate EasyEDA actions for source-backed grounding/keepout inspection,
  GND-pad candidate generation, and fingerprint-gated recoverable placement.
- Recoverable EasyEDA actions for component-geometry inspection, functional
  no-copper Regions, and realized copper pours with generated-fill and critical
  keepout readback.
- A compact official-API roadmap covering connectivity/length audits, semantic
  DRC constraints, bounded calculation waits, event invalidation, and
  source-matched manufacturing evidence.
