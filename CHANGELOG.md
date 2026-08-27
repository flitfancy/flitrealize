# Changelog

All notable changes to FlitRealize will be recorded here.

## [Unreleased]

## [0.1.0-test.5] - 2026-08-27

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
