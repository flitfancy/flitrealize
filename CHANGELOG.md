# Changelog

All notable changes to FlitRealize will be recorded here.

## [Unreleased]

### 变更

- 将原 3.4 综合说明拆成同层的 3.4 布局、3.5 布线规则、3.6 线宽调整和 3.7 网络配色；能力发现直接返回对应说明，保留各操作的执行与恢复约束。
- 同步 Skill、阶段与 Provider 导航、交接模板和各操作的写回要求；View State 保留布局项，将规则、改宽和配色合为网络名称／线宽／颜色表，颜色用实际 HEX 圆点展示，未知值留空标记。表格显式写在主文稿中，保留计划／回读的来源说明；兼容旧记录的原文入口，不从正文推断数值或进度。
- 更新中英文首页、首次使用与面板说明；工程操作脚本接口不变。

## [1.3.1] - 2026-09-20

### 变更

- 新建硬件项目或首次接管已有项目时，Skill 在确认根目录后主动打开 View State，无需另行要求。
- 优先复用已有服务，打开页面时明确选择并核对项目；同一项目后续操作只同步正文和梗概，不重复启动或打开面板。
- 用户明确不需要面板时跳过；环境不可用或启动失败时说明原因并继续硬件工作。缺少主文稿或梗概时保留缺失状态，不为展示编造内容。
- 同步中英文首页、首次使用说明与面板启动步骤。本次只调整 Skill 工作规则和说明，面板程序不变。

[完整代码对比：v1.3.0 → v1.3.1](https://github.com/flitfancy/flitrealize/compare/v1.3.0...v1.3.1)

## [1.3.0] - 2026-09-20

将 View State 作为 Skill 的内置组件分发，并更新 PCB 配色及项目交接流程。

### 新增

- **内置 View State**：`view-state/` 随 Skill 源码与新构建的运行包一起分发，提供本地只读交接面板、原文阅读和 JSON CLI。展示主文稿中明确编写的 `ViewState:` 梗概与当前阶段，支持中英界面、项目切换和刷新；桥接状态独立展示，不推断工程完成度。
- **面板启动入口**：Skill 入口链接启动步骤，包含确认项目、通过健康端点识别并复用服务、后台启动、打开项目页面及核对目标。
- **配色输入检查**：`pcb-routing-plan` 合约版本 3 支持 `requireColor` 和实际 PCB `netNames` 清单，检查整板覆盖、未知网络、完整类选择与缺失配色用途，输出可直接使用的 `colorPlanRequest`。

### 变更

- **固定信号配色**：`pcb-net-color` 合约版本 4 按显式 kind 或 `#RRGGBB` 设置已有网络类颜色，覆盖电源、地、逻辑供电和常用通信/控制信号。相同 kind 跨项目同色，显式颜色优先。
- **两步配色**：`pcb-edit` 的配色流程为 plan → apply；apply 内完成规则恢复、颜色与成员回读及保存。布局与线宽保持原有独立 verify/save 流程。
- **交接约定**：主文稿增加明确的 `当前阶段:` 和章节 `ViewState:` 段落，设计变更同步受影响的当前结论、事实表和未决事项；历史验证注明版本、时间与适用范围。
- **专项参考**：音频说明移至 `references/domains/D.1-audio-systems.md`，按项目需要读取，不作为所有项目的必经阶段。
- **仓库与交付**：更新中英文首页和首次使用说明；统一 Node 测试包含 View State，干净 ZIP 冒烟验证其 CLI、HTTP 服务、静态资源及只读边界。静态路径中的反斜杠在各平台统一拒绝。

### 升级注意

- View State 从本版本开始随运行包分发，启动命令为 `node view-state/server.mjs --project-root "<项目绝对路径>"`，无需额外安装或构建。
- 旧配色指纹计划、独立 verify/save 与配色 `--resume-save` 已停用，需要使用新计划；上游仍负责确定用途及维护 EDA 中已有网络类。
- View State 是可选的只读面板，旧主文稿缺少梗概标记时仍可读取原文，不会自动补写内容。

### 发布验证

- 184 项 Node 测试通过，包含 Skill 与 View State；29 项 Python 发布工具测试通过。
- 仓库校验、Skill 校验及待提交内容扫描通过。
- PowerShell 发布检查通过，干净 ZIP 验证覆盖 View State CLI、HTTP 服务、静态资源，以及原有原理图和 PCB 模拟流程。
- 本次集成不连接 EDA 写入实板；模拟验证和历史实板记录分别保留。

[完整代码对比：v1.2.0 → v1.3.0](https://github.com/flitfancy/flitrealize/compare/v1.2.0...v1.3.0)

## [1.2.0] - 2026-09-15

修复现场暴露的 EasyEDA 兼容问题，并补齐可执行板框入口。硬件阶段文档结构不变。

### 新增

- **`pcb-board-outline`**：在 `BOARD_OUTLINE`（layer 11）用 `pcb_PrimitivePolyline.create` + `pcb_MathPolygon.createPolygon` 创建或替换矩形板框。默认拒绝覆盖已有板框；`replace: true` 仅允许替换唯一已有板框。发现关键词：「板框」。说明见 [3.2](references/providers/easyeda-pro/3.2-pcb-foundation.md)。
- 能力探测补充 `polyline.create` / `polyline.delete`。

### 修复

- **DOCHEAD 快照误报**：EasyEDA 每次 `getDocumentSource()` 会重写 DOCHEAD 的 `client` / `updateTime` / `version`。`pcb-placement`、`pcb-trace-width`、`pcb-net-color` 改为规范化后再比较与计算 fingerprint；真改图仍会 `STALE` / `SNAPSHOT_CHANGED`。规则写入 [development/action-system.md](development/action-system.md)，由脚本写死，不交给运行时模型判断。
- **`schematic-layout` 角色推断**：`JP` / `SJ` / `LJ` 不再因 `/^J/` 被当成 connector；Contract/catalog 的 role 文本优先；仅 `J`+数字按 connector。
- **`schematic-reflow` NC 恢复**：`setDocumentSource` 不携带 pin 级 `noConnected`。apply 前快照 NC；有 NC 且缺少 `sch_PrimitivePin.modify` 时写前失败；import 后写回并在 save 后复核，失败硬报错。

### 升级注意

- 旧 plan 的 fingerprint 因源规范化可能失效，需重新 plan（预期行为）。
- reflow 前若原理图含 NC，必须保证 pin API 可用；无 NC 时行为与原先一致。
- 板框入口目前通过 `action-runner` 调用，尚未挂入 `pcb-edit.mjs` 的 ACTIONS 集合。

### 发布验证

- `scripts/validate.py` 全部通过。
- 全部 Node 测试通过（含 `pcb-board-outline`）。

[完整代码对比：v1.1.0 → v1.2.0](https://github.com/flitfancy/flitrealize/compare/v1.1.0...v1.2.0)

## [1.1.0] - 2026-09-14

在 v1.0.0 之上补齐「clone 后即可冷启动」所需内容：内嵌 EasyEDA Pro 通道，并新增首次使用说明。硬件业务 Action 与通用 `eda-host` 契约不变。

### 新增

- **内嵌 EasyEDA Pro Adapter 通道** `adapters/easyeda-pro/`：包含 `bridge-control.mjs`、`bridge-server.mjs`、`request-store.mjs`、`package.json` 与恢复说明。注册默认路径为 `<skill>/adapters/easyeda-pro`，不再依赖第二仓库才能 `register`。
- **首次使用说明** `docs/first-run.md`：分层写清离线设计 / 脚本 / 接入 EDA；区分通用宿主契约与当前 Provider 实现；给出冷启动命令、人工步骤边界与卡住对照。

### 变更

- 发布 ZIP 包含内嵌 Adapter 源码通道（不含 `node_modules` 与本机会话状态）。
- 仓库校验忽略 `node_modules`，避免依赖文档破坏链接检查。
- README 标注当前正式版本为 `v1.1.0`，并指向首次使用说明。

### 升级注意

- 本机若已把 `easyeda-pro` 注册到外部 Adapter 目录，可继续使用；新用户应改用树内 `adapters/easyeda-pro`。
- EasyEDA Pro 客户端与 API Gateway 扩展仍须在嘉立创侧安装，不在本仓库内。
- 运行包现包含通道源码；完整 API 类文档与独立 Skill 形态仍以 `easyeda-api-skill` 上游为准。

### 发布验证

- `scripts/validate.py` 全部通过；全部 Node 行为测试通过。
- 内嵌目录完成 `npm install`、`bridge-control status` 与 `eda-host register` 冒烟。

[完整代码对比：v1.0.0 → v1.1.0](https://github.com/flitfancy/flitrealize/compare/v1.0.0...v1.1.0)

## [1.0.0] - 2026-09-14

FlitRealize 首个正式版本。版本号由 `1.0.0-test.3` 升至 `1.0.0`，产品显示名、Git 标签说明和 Release 标题去掉 T1；正式版标为 GitHub Latest，历史测试标签保留。

### 相对 v1.0.0-test.3

- 已登记 Action 从 17 个增加到 23 个，新增 PCB 布局、指定线段改宽、网络类配色、离线布线计划，以及原理图重排和非连接标识。
- 中文成为唯一维护和执行源；主 Skill、阶段参考和开发说明保留原入口。英文历史说明固定保存在 `docs/en-backup/`，旧中文镜像改为跳转，不再维护两套执行正文。
- 一份 `CURRENT_HANDOFF.md` 贯穿硬件全流程：顶部短交接、正文保留设计理由和物理引脚/网络/布局事实。新增交接检查和派生事实同步工具，区分文件一致、现场验证和阶段完成。
- Action runner 支持按中文或英文用途查询，返回实际执行入口、阶段参考和能力边界。主机入口保留 Bridge 请求 ID、会话和未知结果，支持只读查询而不重放写入。

### 原理图

- 新增批量放件编排：Contract 审计、器件绑定、布局、代表批次、分批写入、回读、保存和中断续接使用同一组 Action 与证据。
- 新增连接编排：从明确的引脚网络意图生成短线、网络标识和 NC，补齐缺失连接、审计、重排并衔接保存与严格 DRC；已有正确连接不重复创建。
- 修正器件 Value 的生成与供应商标准值回读，显式处理未连接引脚；关闭新建 netflag/netport 的重复名称显示，保留导线网络名称。
- 保存和 DRC 兼容详细条目、聚合计数及布尔返回；未知结果不按通过处理，放件阶段跳过 DRC 时明确记录。

### PCB

- 新增 `pcb-edit.mjs`，统一计划、写入、验证和独立保存；保存失败可以单独恢复，不重放已经完成的修改。
- 布局工具支持功能块平移、候选比较和空白检查，保留固定器件与预留区，拒绝直接移动已有走线的板。
- 线宽工具只修改明确选中的铜层直线，保护窄逃逸段；基于详细 DRC 基线判断新增或变化的问题，允许修复带有旧违规的板。
- 离线布线计划按项目给定的网络分类、优先级和线段角色生成执行顺序、改宽与配色请求；不代表已经执行自动布线。
- 网络配色改为重建选定的已有网络类，保留完整成员与规则。创建时使用 `alpha: 255`，回读验证 `alpha: 1`，不再写入或清除单网络颜色覆盖；说明中提供可复制的八色色板。
- 修正铺铜、keepout、地过孔等创建动作的目标切换、对象归属和异常恢复边界，部分失败保留现场与原始证据。

### 升级注意

- `pcb-net-color` 合约升级为版本 2。必须传已有网络类的完整成员和明确 `#RRGGBB`；旧逐网计划须重新生成，`null` 清除颜色不再支持。网络类不存在时不自动创建。
- 连接、放件和编辑工具将计划、写入、回读、保存和未知终态分开记录；旧报告不能仅凭“之前成功”直接作为新的写入或保存依据。
- API 回读通过不代表画布效果通过。网络类配色首次现场使用仍应验证代表类；本版本没有自动清除历史单网络覆盖。

### 发布验证

- 发布流程执行仓库与 Action 注册校验、全部 Node 行为测试、Python 发布工具测试、暂存内容扫描、确定性 ZIP 构建、SHA-256 校验和干净解压环境冒烟测试。
- 正式版标识是软件发布状态，不替代每个项目的实际 EDA、DRC 或硬件验收。运行包不包含本机 Adapter、项目制品、第三方安装包或历史文档备份。

[完整代码对比：v1.0.0-test.3 → v1.0.0](https://github.com/flitfancy/flitrealize/compare/v1.0.0-test.3...v1.0.0)

## [1.0.0-test.3] - 2026-09-01

This release consolidates the project's human-readable design and continuation
state into one `CURRENT_HANDOFF.md` that follows the hardware from requirements
through parts, schematic, PCB, manufacturing, and prototype validation.

### Changed

- Reworked the main Skill around one project manuscript while keeping the
  Contract, EDA source, manufacturing outputs, and raw test records as the
  owners of their respective machine facts.
- Rewrote the continuation, requirements, parts, schematic, PCB, manufacturing,
  validation, and release references so each stage updates only its own section
  of the project manuscript.
- Allowed confirmed schematic blocks to enter EDA independently while unresolved
  blocks remain visible in the manuscript, avoiding an unnecessary whole-project
  gate.
- Kept `DEFAULT_MODE` as the ordinary direct path and limited `CURIOUS_MODE` to
  the local decision that needs deeper evidence.
- Synchronized the English runtime documents and Chinese review mirrors, including
  source hashes and the maintainer Action-system documentation.

### Validation status

- Repository validation, all 18 Node Action tests, all 16 Python release tests,
  Skill validation, deterministic packaging, and clean-archive smoke testing are
  covered by the release workflow.
- Live EDA behavior and physical hardware remain practical validation work; this
  documentation release does not claim new board-level evidence.

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
