> 本文件是英文开发文档 [action-system.md](../../../development/action-system.md) 的中文镜像，供人工阅读和审阅。实际维护仍以英文源文件为准。

# Action 与 EDA Provider 开发

只有修改 Action runner、Action manifest、已有 Provider，或者实现新的 EDA Provider 时读取本文档。

普通硬件设计和正常 EDA 操作不需要读取。

## 系统边界

`SchematicContract` 保存与具体 EDA 无关的设计意图。

EDA Provider 负责把这些意图转换成目标 EDA 中的器件与库身份、引脚与网络、文档对象与几何，以及写入、保存和回读结果。

Action 的 plan、snapshot 和 report 是执行制品，不是新的项目数据库。稳定设计意图仍然保存在项目契约和 EDA 源文件中。

## Action 与 Workflow

`scripts/actions/manifest.json` 登记可以执行的 Action 和 Workflow。

Action 表示一个可以独立运行和验证的操作。Workflow 只描述多个已有 Action 的执行顺序，不再建立另一套通用工作流语言。

内部 Action 可以从普通发现结果中隐藏，但仍应在 manifest 中登记、可以按准确名称调用、具有明确输入输出并能够独立测试。

Manifest 不应登记尚未实现的 Provider、Action 或 Workflow。

## 新增 Provider

新的 EDA Provider 不需要模仿 EasyEDA 的内部实现，但应支持当前工作流实际需要的能力，至少能够：

1. 检测当前环境和可用能力；
2. 把可移植设计意图映射到原生器件、引脚和文档对象；
3. 读取实际文档状态；
4. 对目标对象执行有边界的修改；
5. 通过原生 ID 或等效身份回读结果；
6. 明确返回成功、不支持或状态未知。

只有 Provider 已经能够完成至少一个真实操作，并经过相应测试后，才加入公开 manifest。不要用空目录、占位 Adapter 或始终返回成功的模拟实现表示 Provider 已经受支持。

## 写入事务

当操作存在实际恢复价值时，使用：

```text
inspect → plan → apply → verify
```

执行前确认目标文档和相关对象仍然与 plan 一致。文档经过手工修改、重新打开或长时间中断后，应重新读取实际状态。

写入后直接回读目标对象，确认本次要求的增量已经实现，并且没有意外覆盖原有对象。保存是独立且明确的操作；无法真正恢复的操作不要声明存在 rollback。

Provider 应分别报告已完成、不支持、状态未知、实际阻塞问题和已经验证的范围。

## 临时运行文件

一次执行产生的输入副本、Bridge 片段和报告可以放在：

```text
.flitrealize/runs/<run-id>/
```

这些文件只服务于当前事务。执行完成并确认不再需要恢复后，可以删除对应 run。需要长期保留的设计、证据或制造文件应移动到项目正式目录，并由 `CURRENT_HANDOFF.md` 或对应阶段文件引用。

`.flitrealize/runs` 不能成为稳定设计意图、EDA 源文件或验证证据的唯一保存位置。

## 扩展与维护

只有重复操作确实能够减少错误或明显节省工作时，才增加新的 Action 或 Workflow。

修改现有实现时：

1. 先用真实失败或重复需求说明问题；
2. 把问题缩减成可以重复测试的输入；
3. 修改负责该行为的最小模块；
4. 添加能够观察实际结果的测试；
5. 保留仍然不支持的范围。

系统价值由能否可靠复用、拒绝过期操作和验证实际结果决定，不由 Action 数量决定。
