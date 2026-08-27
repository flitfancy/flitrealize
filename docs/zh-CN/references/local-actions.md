> 本文件是英文参考文件 [local-actions.md](../../../references/local-actions.md) 的中文只读镜像，供人工阅读和审阅。实际执行仍以英文源文件为准。
> 同步日期：2026-08-27（Asia/Shanghai）
> 英文源文件 SHA-256：`7448DD6F27AF1C435738F3613287021B832EEAE13AA5D8D77B0C871469DAE068`

# 可复用本地 Action 与 Provider 边界

当重复项目工作应转化为确定性 Action、需要修改 Action Runner 或 Manifest，或者需要增加 EDA Provider 时读取本参考。普通的一次性分析不要加载。

## 用职责分离维护唯一的项目事实

- 项目合同拥有设计意图。
- 源工件或结构化 Snapshot 记录实际实现状态。
- Action 输入拥有一次边界明确的请求操作。
- Action 报告是执行证据，不是第二套项目数据库。
- 证据解释完成后，由 `CURRENT_HANDOFF.md` 记录当前结论和下一动作。

不要让生成报告静默地重新定义设计意图。设计意图发生变化时，应先更新其所属合同，再复用依赖该意图的写入操作。

## 注册执行契约

`scripts/actions/manifest.json` 是唯一公开注册表。Manifest schema 2 为每个 Action 声明：

- `contractVersion`：输入/输出契约版本；
- `domain`：它服务的硬件或系统领域；
- `runtime`：`host` 表示本机确定性计算，`eda` 表示实时 EDA 操作；
- `providers`：经过准确测试的 EDA Provider；host Action 使用空数组。

只有当 EDA Action 正好声明一个 Provider 时，Runner 才会自动推断。否则必须显式选择 Provider。执行前拒绝未注册或与 Action 不兼容的 Provider。注册表只收录已经有实际测试 Adapter 的 Provider；不要创建空厂商目录，也不要宣称未来支持已经存在。

Host Action 根据结构化输入在本机执行，不经过 EDA Bridge。EDA Action 通过选中的主机 Adapter 执行，并继续遵守实时写入锁。两种 Runtime 共用同一套模式/修改授权、精简摘要和主机本地完整报告外壳。

不依赖 Provider 的 `schematic-contract-audit` 是第一个 Host Action。它校验可移植设计意图，不导入 EDA API，也不声称实际原理图已经匹配。

## 让输出有价值，同时不隐藏覆盖范围

默认输出应包括 Action 身份、契约版本、领域、Runtime、Provider、模式、是否修改、适用时的文档身份、指纹、有用计数、问题数量，以及是否存在下一请求或回滚请求。完整响应保存在本地报告中。

分别报告 `unsupported`、`unknown`、阻断项和相关覆盖范围。`PASS` 只证明声明过的检查范围。API 对象缺失或图元未识别时，不能把它当成空设计。

多个 Action 共享实际状态或授权差异时，使用带版本的 Snapshot 和 Patch 格式。Provider 原生 ID 保持不透明；Provider 扩展放入带命名空间的字段，不要泄漏到可移植的决策规则中。

## 根据证据进化，而不是不断堆积

当确定性执行能提高可靠性或避免模型反复完成大量工作时，再把重复操作提升为 Action。遇到一次真实失败或未知情况后：

1. 将其分类为输入错误、规则缺口、Provider 漂移、不支持的几何，或设计决策；
2. 在适合时缩减为脱敏 Fixture；
3. 加入一个会因已观察原因而失败的回归测试；
4. 只修改最小的所属规则、Action 或 Adapter；
5. 重新运行旧的正例、反例、边界和回滚案例；
6. 发布实际行为和剩余不支持范围。

单个项目特有的方法仍然只是候选，除非有权威证据或性质明显不同的项目支持提升。不要让本地 Action 根据一次运行自行改写可复用规则；它可以报告候选规则，等待审阅。

## 检测陈旧状态并失败关闭

把可复用计划绑定到相关合同、Snapshot、文档、Adapter 和能力指纹。手动修改源文件、切换选中文档、Provider/API 变化或所需能力失败后，使计划失效。写入后验证预期差异和受保护不变量；回读不能证明结果时，停止并给出准确的不支持证据。

用原始数据到摘要的压缩比例、缓存或差异复用率、覆盖率、误报率、不支持数量、零未授权变化和经过验证的回滚来衡量价值，而不是只统计 Action 数量。
