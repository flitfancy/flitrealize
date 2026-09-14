# Action 与 EDA Provider 开发

只有修改 Action runner、Action manifest、已有 Provider，或者实现新的 EDA Provider 时读取本文档。

普通硬件设计和正常 EDA 操作不需要读取。

## 系统边界

`SchematicContract` 保存与具体 EDA 无关的设计意图。

EDA Provider 负责把设计意图转换成目标 EDA 中的器件与库身份、引脚与网络、文档对象与几何，以及写入、保存和回读结果。

Action 的 plan、snapshot 和 report 是执行制品，不是项目数据库。

稳定结果分别进入：

- Contract 或对应机器制品；
- EDA 源文件；
- 制造或测试文件；
- `CURRENT_HANDOFF.md` 中对应的人类可读章节。

## Action 与 Workflow

`scripts/actions/manifest.json` 登记可以执行的 Action 和 Workflow。

Action 表示一个可以独立运行和验证的操作。

Workflow 描述多个已有 Action 的执行顺序，不建立另一套通用工作流语言。

多步输入输出已经稳定且需重复执行时，用薄封装复用 Action；例如 `schematic-components.mjs` 冻结批次输入，先记录写入意图、后保留终态回执，再按实际对象 ID 续接。事务文件只属于该次运行，不自动改写项目主文稿；未知写入没有确定终态时不能重试或以新批次绕过。

`pcb-edit.mjs` 只衔接已有布局、线宽和配色 Action 的计划、修改、验证与保存，不引入新输入语言。只恢复保存时复用项目内的成功 apply 报告，不重放修改。

`schematic-connect.mjs` 使用 Contract 与现场计算端点短线、标识和 NC 缺项，并衔接要求的重排、保存和严格 DRC。某步无对象时记录不适用，不能把没有调用底层 Action 误报为遗漏或失败；存在明确对象时则验证结果。输入不携带某个历史项目的 UUID、器件列表或布局常数。

内部 Action 可以从普通发现结果中隐藏，但仍应：

- 在 manifest 中登记；
- 可以按准确名称调用；
- 具有明确输入输出；
- 能够独立测试。

Manifest 只登记已经实现的 Provider、Action 和 Workflow。

`action-runner.mjs list --full` 从这份登记表展开内部 Action 和 Workflow 步骤；默认列表保持简洁，不另行维护一份能力目录。

### 用途发现元数据

Action 和 Workflow 可以在同一条注册记录中声明 `discovery`：

```json
{
  "keywords": ["原理图重排", "布局美化", "reflow"],
  "reference": "references/providers/easyeda-pro/2.2-schematic-workflow.md",
  "entrypoint": "scripts/schematic-reflow.mjs",
  "limitations": ["只处理已支持的原理图对象，不是 PCB 布局优化器。"]
}
```

只填写实际用途和已存在的运行文件。`reference` 指向中文阶段说明，`entrypoint` 仅在已有封装脚本时填写；普通 Action 的调用参数和 Workflow 的步骤直接由原登记记录派生。不得为了让查询命中而登记尚未实现的能力。

`list --query` 检索名称、说明、域和 `keywords`，不检索限制说明；限制中出现某用途不能让不支持该用途的能力被命中。匹配 Workflow 时同时返回它依赖的 Action，并区分 `direct` 与 `workflow-step`，不扩大到无关域。

新增或修改发现信息时测试：真实入口存在、用途命中、域隔离、空结果、调用形态以及只读查询无副作用。旧默认列表和 `--full` 继续兼容。发现测试不替代实际 Action 或 EDA 验证。

入口区分通信成功和 Action 的实际结果。新增状态时，同步入口认可的完成状态及行为测试。被阻止、验证失败、结果未知，以及 apply 失败后的自动回滚，不能返回 `ok: true` 或零退出码。主动请求的回滚可以独立成功；部分检查和条件性审计保留各自的明确限制。

EDA 通信抛错也要保留 unknown 报告，尤其不能把可能已执行的写入当成未执行。Manifest 结构检查统一复用 runner 的 `loadManifest`；Python 发布检查另负责文件清单与文档快照，不维护第二份字段规则。

EasyEDA 主机入口透传 Bridge 的请求句柄与提交回执，runner 在成功及异常报告中保留它们；`eda-host.mjs request` 只读查询原请求。迟到结果是补充证据，不自动重写旧 Action 报告、批次日志或 PCB 保存占用记录，也不触发重放。

## 新增 Provider

新的 EDA Provider 不需要模仿 EasyEDA 的内部实现，但应支持当前工作流需要的能力：

1. 检测当前环境和能力；
2. 把可移植设计映射到原生器件、引脚和文档对象；
3. 读取实际文档状态；
4. 对目标对象执行有边界的修改；
5. 通过原生 ID 或等效身份回读结果；
6. 明确返回成功、不支持或状态未知。

Provider 至少完成一个真实操作并具有相应测试后，才加入公开 manifest。

## 写入事务

操作存在恢复价值时使用：

```text
inspect → plan → apply → verify
```

执行前确认目标文档和相关对象仍然与 plan 一致。文档经过手工修改、重新打开或长时间中断后，重新读取实际状态。

写入后回读目标对象，确认本次增量已经实现，并且没有意外覆盖原有对象。

保存是独立操作。无法真正恢复的操作不声明 rollback。

## 临时运行文件

一次执行产生的输入、Bridge 片段和报告可以放在：

```text
.flitrealize/runs/<run-id>/
```

这些文件只服务当前事务。执行完成并不再需要恢复后，可以删除对应 run。

稳定设计、EDA 源文件和验证证据进入项目正式目录。影响项目判断的结果同步到 `CURRENT_HANDOFF.md` 的对应章节。

`.flitrealize/runs` 不保存任何稳定制品的唯一副本。

需要供后续阶段引用的结果报告，应连同相关输入版本保留到项目稳定证据目录，并按 [项目续接](../references/0.1-continuation.md) 在主文稿中记录范围和入口。`handoff-check.mjs` 只检查这些引用的完整性，不解析所有 Provider 报告，也不替 Action 验证。不要让通用 runner 仅凭通信成功自动把项目写成完成；由当前工作流依据实际结果更新受影响结论。

## 扩展与维护

只有重复操作确实减少错误或明显节省工作时，才增加 Action 或 Workflow。

修改实现时：

1. 用真实失败或重复需求说明问题；
2. 把问题缩减成可重复测试的输入；
3. 修改负责该行为的最小模块；
4. 添加能够观察实际结果的测试；
5. 保留仍然不支持的范围。

系统价值来自可靠复用、过期操作拒绝和实际结果验证，不来自 Action 数量。
