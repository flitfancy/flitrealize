# 能力发现与执行数据约定

本页集中能力发现、操作原状态、公共回执与结果字段。现场步骤、保存与未知结果的业务判断只在 [0.3](../docs/0.3-easyeda-pro.md)维护；字段定义不替代该流程。

## 能力清单元数据

脚本入口有子命令时，可在 discovery.commands 登记固定 args 与 mutates。查询时作为 entrypoint.commands 返回；操作的 modes 仍只描述操作本身，不因关联脚本而虚报可执行模式。

已有条目可声明：

```json
{
  "keywords": ["原理图重排", "布局美化", "reflow"],
  "reference": "docs/providers/easyeda-pro/2.2-schematic-workflow.md",
  "entrypoint": "scripts/schematic-reflow.mjs",
  "limitations": ["仅处理已支持的原理图对象。"]
}
```

`reference` 指向专项说明；`entrypoint` 仅填写已存在的封装脚本。`list --query` 检索名称、说明、域和关键词，不检索限制文字；流程结果区分直接入口和依赖步骤。

## 操作状态与原状态

新增算法状态由薄入口映射到操作完成状态约定，并保留原 `operationStatus`。

## 发现返回与路径

`reference` 和 `entrypoint.file` 相对于 Skill 根目录，操作的 `file` 相对于 `scripts/actions/`。返回值区分：

- `script`：已有封装入口，负责衔接步骤并保留报告。
- `action-runner`：按结果给出的名称、参数和本次输入调用。
- `workflow-steps`：步骤说明，不是直接执行命令。

## 布局验收回执

原不可变 apply 回执的 `acceptanceEvidence` 绑定输入、请求、候选、实现及路由是否必需；有路由回执时另绑定其哈希和引用。续存和复核读取原绑定证据，不复制第二份，不改变路由铜的离线状态。已绑定证据缺失、修改，或候选／规则变化时停止，不能用另传对象替换已绑定证据。

局部写回继续以 `snapshot` 和 `plan` 保存候选的原始绑定；`writeBaseline` 保存实际写入前现场，`writeSet` 列出本次器件／位号／焊盘 ID（包括器件自动带动的附属对象），`preservedChanges` 列出保留的现场源记录 ID、位号、变化种类及字段。写后、保存回读和已知保存失败续接复用同一现场基线；旧回执没有这些字段时沿用原 `snapshot`。这些字段属于原执行回执，不生成第二份项目状态。

## 布局复核与保存字段

`verify` 只调用已有 `verifyLayout`，返回 `verification.json`。`state.saved` 的 true／false／null 来自原保存链证据，分别表示本链已确认保存、未保存或确定保存失败、保存结果未知；几何匹配不把 null 改为 true。`savePending/saveUnsettled` 表示原保存链占用或未决，与保存事实分别记录；复核不清理占用、不重写旧报告。该复核检查原生源指纹、目标、完整候选和实际对象，不代替磁盘工程验读、DRC 或实际铜验收。

## PCB 编辑复核字段

`result.json` 汇总分步证据。此入口只读 verify 不查询保存，返回 `saved: null, saveChecked: false`；保存状态与交接同步按 [0.3](../docs/0.3-easyeda-pro.md) 和[布局操作的项目主题说明](../docs/providers/easyeda-pro/3.5-pcb-placement.md#同步项目交接)。

## 网络配色保存字段

本操作的 `saved:false` 为未尝试，执行结果的 null 为保存未确认，预览的 null 为未检查；共同状态与保存回读判断见 [0.3](../docs/0.3-easyeda-pro.md#现场边界与验证)。

## Bridge 返回位置

普通 execute 的业务返回值在 `result`，查询取得的在 `request.result`；网关错误在 `request.error`。即使查询退出码为 0、顶层 `success: true`，也须检查内层状态和业务结果。

## Bridge 请求状态

| 状态 | 含义 |
| --- | --- |
| running | 已接受，尚未收到终态 |
| unknown | 超时、断连、重启或无法证明终态 |
| succeeded | 收到本请求对应网关的返回值 |
| failed | 收到对应网关的错误结果 |
