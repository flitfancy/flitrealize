> 本文件是英文开发文档 [action-system.md](../../../development/action-system.md) 的中文镜像，供人工阅读和审阅。实际执行以英文文档为准。

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

内部 Action 可以从普通发现结果中隐藏，但仍应：

- 在 manifest 中登记；
- 可以按准确名称调用；
- 具有明确输入输出；
- 能够独立测试。

Manifest 只登记已经实现的 Provider、Action 和 Workflow。

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

## 扩展与维护

只有重复操作确实减少错误或明显节省工作时，才增加 Action 或 Workflow。

修改实现时：

1. 用真实失败或重复需求说明问题；
2. 把问题缩减成可重复测试的输入；
3. 修改负责该行为的最小模块；
4. 添加能够观察实际结果的测试；
5. 保留仍然不支持的范围。

系统价值来自可靠复用、过期操作拒绝和实际结果验证，不来自 Action 数量。
