> 本文件是英文参考文件 [local-actions.md](../../../references/local-actions.md) 的中文只读镜像，供人工阅读和审阅。实际执行仍以英文源文件为准。
> 同步日期：2026-08-30（Asia/Shanghai）
> 英文源文件 SHA-256：`02EBCC6D053C307DA9E7063B005D0DDFB9CA35EF7447B64D445BD34E29B21BA5`

# 可复用本地 Action 与 Provider 边界

修改 Action runner 或 manifest、把重复操作提升为 Action，或实现真实 EDA Provider 时读取本参考。普通一次性分析不必加载。

## 只保留一个可移植边界

- `SchematicContract` 保存可移植设计意图。
- `schematic-contract-audit` 是进入 Provider 工作前的边界检查。
- Provider 负责库身份、现场几何、写入和回读。
- Snapshot 记录已实现状态；report 记录执行证据。
- 生成的 plan 和 report 都不能变成第二套项目数据库。

正常原理图入口刻意保持很小：

```text
Contract Audit -> Components -> Connect -> Finalize
```

`Contract Audit` 是公开 Host Action；另外三项是公开 workflow 描述，由内部细粒度 Action 支撑。Runner 不引入新的通用工作流执行引擎；Skill 按声明的阶段执行，并把上一步结果传给下一步。

## 登记公开 Workflow 与内部 Action

`scripts/actions/manifest.json` 是注册表。扁平 `actions` 对象保留稳定精确查找名。Action 声明 `contractVersion`、`domain`、`runtime`、支持的 `providers`、mode 和写入属性。`internal: true` 只把实现 Action 从正常发现界面隐藏，不会让它失去登记或测试能力。

`workflows` 对象只提供发现和编排元数据。每个 workflow 指定一个已测试 Provider，以及 `prepare`、`apply`、`verify`、`rollback` 等阶段的有序步骤。Manifest 加载会拒绝未知 Action、mode、Provider、domain 不一致和非法 optional 步骤。

`action-runner.mjs list` 返回公开 Actions、公开 workflows、`actionGroups` 和 `workflowGroups`；`list --domain schematic` 同时筛选两种入口。内部 Action 仍可按精确名称运行，用于 workflow 编排、调试和回归测试。写入授权仍按每个 Action 执行。

## Provider 代码必须对应真实实现

Host Actions 位于 `scripts/actions/`，EasyEDA 代码位于 `scripts/actions/easyeda-pro/`。Manifest 的 file 路径以 `scripts/actions/` 为基准且精确；旧的 Provider 相对 basename 回退只用于兼容。

不要用空的 KiCad、Altium 或其他目录表示架构。只有具备可工作的 Adapter 边界、能力探测、至少一个已实现 Action、mock 回归覆盖和有边界的现场检查时才登记 Provider。新 Provider 实现相同的可移植 Contract 边界和 workflow 结果，不必在内部模仿 EasyEDA primitive。

扩展工作因此只需：

1. 把可移植意图映射到原生库/器件/引脚身份；
2. 把原生文档状态捕获到共享 Snapshot 边界；
3. 用按 ID 回读实现有边界的原生写入；
4. 只登记已经测试的 Actions 与 workflows；
5. 保留 unknown 和 unsupported 覆盖，不能返回空成功。

在两个真实 Provider 证明有需要以前，不增加 provider-to-file 抽象。

## 内部制品保持适度

只有跨越实质边界或被多个独立子系统消费的制品才提升为共享版本化 schema。Contract、PlacementPlan 和 Snapshot 达到这个标准。EasyEDA 连接规划只是内部瞬态结果，因此保留带版本的 Action 结果结构，但不提升为公开 JSON Schema。Provider binding 解析同样返回瞬态 `providerBindings` map；项目需要持久化时，可把选中的 binding 缓存在 `contract.components[].bindings.<provider>` 下，不需要单独的 BindingSet 数据库。

## 保持 run 可丢弃

把本次运行的工作文件放入一个事务目录：

```text
.flitrealize/runs/<run-id>/
├── inputs/
├── bridge/
└── reports/
```

`inputs/` 用于 request、为执行复制的 Contract 和 plan；`bridge/` 用于生成的 Provider 代码或命令片段；`reports/` 用于瞬态 inspect/apply/verify 结果、Snapshot 和覆盖报告。通用 bridge 基础设施、Action runner 和可复用 Provider 逻辑保留在 Skill 或 adapter 中，不复制到每个项目。

写入尚未完成、验证未结束或仍可能需要 rollback 数据时保留该 run。成功对账后删除整个 run；普通的已放弃失败也删除。只有 `BATTLE_LOG.md` 仍引用反复出现的活动故障时才保留故障 run。只把选定的耐久证据提升到 `evidence/`，并由当前项目状态引用。删除 `.flitrealize/` 绝不能丢失稳定设计意图、权威 EDA 源文件或保留证据的唯一副本。

## 保留事务安全

Provider 写入在 rollback 有意义时仍使用 plan/apply/verify/rollback。Plan 绑定选中文档及相关 Contract、binding、capability、Snapshot 和 geometry 指纹。手工修改或超时后必须重新 inspect。通过创建出的原生 ID 验证请求增量并保护原有 ID；全局枚举只是覆盖证据，不能替代目标回读。

Save 必须显式执行且没有伪 rollback。分别报告 `unsupported`、`unknown`、blocker 和 coverage。`PASS` 只证明声明过的检查范围。

## 从证据演进

只有重复逻辑确实减少错误或大量重复工作时才提升。真实失败发生后，先分类，再缩减为脱敏 fixture，添加回归，修改最小归属规则，并记录剩余不支持范围。用可靠复用、过期 plan 拒绝、覆盖率和可验证恢复衡量价值，而不是 Action 数量。
