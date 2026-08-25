---
name: flitrealize
description: 以项目隔离和证据驱动决策，推进有持续状态的电子硬件项目，覆盖需求、原理图、PCB、原型下单、上电与改版。适用于项目级 EDA 工作或跨对话续接；不要用于纯软件工作、孤立器件事实、教材问题或无需项目状态的一步式 EDA 指导。
---

> 本文件是英文主执行文件 [SKILL.md](../../SKILL.md) 的中文只读镜像，供人工阅读和审阅。实际执行仍以英文源文件为准。
> 同步日期：2026-08-25（Asia/Shanghai）
> 英文源文件 SHA-256：`3052472AE3FE30A9A4B3FA0651DA29E8A994A59C509BD53669F8F15EB66406B9`

本文件是主执行文件的完整翻译；整个 Skill 还包括 `references/` 中 9 个按需读取的中文专题参考，并不是只包含本文件。

# FlitRealize

## 目标

用最轻但可靠的过程推进当前硬件决策。默认目标是可测试的个人原型；项目事实留在正确项目内，后续改版由测量证据驱动。

## 选择项目、意图和证据

### 项目与可写范围

- **NEW_PROJECT：**仅当用户明确要求新建或独立项目时使用；不得继承其他项目状态。
- **EXISTING_PROJECT：**继续、修改、评审、调试或制造已识别的项目/制品。确认精确根目录后先读 `CURRENT_HANDOFF.md`；只有 `BATTLE_LOG.md` 描述活动子系统故障时才随后读取。
- 只有当歧义会改变写入位置或受保护基线时，才问一个窄的身份/根目录问题。

研究、Skill/catalog 维护、只读 capture、项目编辑和实时 EDA 修改是不同范围。除非用户要求变更，否则分析保持只读。

对于已确认项目根目录内的普通请求修改，简短说明范围后即可执行。以下情况使用完整锁定：新根目录、批量迁移、删除/移动、已评审基线或制造输出、实时 EDA 写入。

```text
PROJECT_ROOT: <精确根目录>
ROUTE: NEW_PROJECT | EXISTING_PROJECT
WRITABLE_SCOPE: <精确子树>
PROTECTED: <基线或同级根目录>
RECOVERY_AND_CHECK: <检查点与成功判据>
```

实时 EDA 还要注明精确文档、预期增量和受影响对象上限。下单、付款或覆盖已评审基线等重大外部动作，需要针对该动作单独确认。初始化和制造身份细节见 [production-handoff.md](references/production-handoff.md)。

### 任务意图

- **FAST_PROTOTYPE：**个人和一次性板卡的默认模式。阻断很可能导致功能、安全或制造失败的问题；其他有边界的缺口记录为假设或到货测试。
- **ENGINEERING_REVIEW：**只检查指定制品或问题，报告证据、不确定性和最小有用下一步。
- **PRODUCTION_RELEASE：**仅用于明确的批量、PCBA、可复现性或正式发布。准备度必须有实物原型证据。

对于市电、电池/充电、高压/大功率、医疗、法规或其他安全关键工作，应核对当前适用标准并取得所需专业评审；本通用 Skill 本身不能作为发布证据。

### 证据状态

证据缺失或冲突时为 **OPEN**；缺失证明的后果有边界并有复查测试，且继续原型工作是安全的，则为 **CONDITIONAL**；只有所需证据与活动版本一致时才是 **PASSED**。`automated-green`、`visual-accepted`、`manufacturing-checked` 和 `physical-verified` 证明不同事实，互不蕴含。

只有详细生命周期跟踪或正式生产确实有助于当前决策时，才读取 [stage-gates.md](references/stage-gates.md)。

## 通过三个原型检查点推进

### 1. 原理图正确性

检查需求、接口、电源、安全默认状态、主电路、引脚、额定值、数值、封装、替代、测试方法和保留 ERC 例外。陌生或后果较大的组合路径需要针对性证据，或保持条件通过。读取 [schematic-contract.md](references/schematic-contract.md)；音频路径另读 [audio-systems.md](references/audio-systems.md)。

只有当项目复杂度、手工 EDA 协作或用户确实受益时，才生成 `ALL_VIEW.md` 等人类总览；机器可读契约仍是权威。

### 2. 原型下单检查

把已保存源版本与导出配对。验证关键封装和方向、连通性、板框、孔、间距、铺铜、已配置 DRC、Gerber/钻孔内容和板厂预览。只有新的或不确定的 generator/template/fabricator 链路会带来实质制造风险时，才先跑 toy board 导出。

布线前，在当前契约或选定的人类总览中记录网络类、关键拓扑、回流要求和有序布线计划。读取 [pcb-review.md](references/pcb-review.md)；EasyEDA 自动化或导出另读 [easyeda-pro.md](references/easyeda-pro.md)。

### 3. 实物上电

先检查并测量未上电电源轨对地电阻；使用保守限流上电，先验证电源轨，再逐块启用。真实负载、可信故障、上下电和日志测试的时长与覆盖度，由原型风险和验收目标决定。读取 [prototype-validation.md](references/prototype-validation.md)。

## 执行不变量

- 当前用户明确指令拥有目标、范围和授权；项目契约、主数据手册、当前平台文档和制造商约束拥有技术事实。
- 只有会改变架构、安全、制造、不可逆编辑、项目身份或完成定义的歧义才需要确认。
- 保护已接受的手工 EDA 和已评审基线。大范围变更需要当前 capture；手工修改引脚、封装、布局、布线、板框或 keepout 后，冲突的生成 apply 脚本立即过期。
- 在扩展陌生或重复 UI/API 工作前先验证一个代表对象；重复足以获益时优先数据驱动自动化。
- 失败后使用新证据。只有活动子系统需要反复聚焦实验时才读取 [debug-loop.md](references/debug-loop.md)；普通实现或已完成任务不创建 battle log。

如果宿主明确提供了工作区本地硬件知识 catalog 或用户偏好文件，仅在相关且处于可读范围时查询。缺少这些可选资料不得阻塞核心流程，也不得假定作者本机路径。单项目方法保持 candidate，直到实质不同项目提供真实支持证据；知识层晋升还要求该层在可写范围内。

## 保存当前状态

每个项目根目录只有一个 `CURRENT_HANDOFF.md`，保存稳定身份、版本、决策、已验证事实、风险、权威制品和主要下一步。它保存当前状态而不是历史。`BATTLE_LOG.md` 是可选临时文件：只覆盖一个活动且不稳定的子系统，读取顺序在 handoff 之后；稳定结论合并回 handoff 后归档或删除。

续接或更新状态时读取 [continuation.md](references/continuation.md)。即使未授权持久化，过期或不安全判定也立即生效；此时不得执行相关制品，并报告警告尚未持久化。

## 只加载相关细节

- 原理图和器件：[schematic-contract.md](references/schematic-contract.md)
- PCB 和制造图形：[pcb-review.md](references/pcb-review.md)
- EasyEDA Pro 自动化：[easyeda-pro.md](references/easyeda-pro.md)
- 活动且重复的调试：[debug-loop.md](references/debug-loop.md)
- 音频路径：[audio-systems.md](references/audio-systems.md)
- 上电：[prototype-validation.md](references/prototype-validation.md)
- 续接与状态归属：[continuation.md](references/continuation.md)
- 初始化、采购和制造包：[production-handoff.md](references/production-handoff.md)
- 详细生命周期/正式发布：[stage-gates.md](references/stage-gates.md)

当前决策已有支持后停止加载。

## 报告决策

先给当前决策，再给阻塞项、已接受风险、不确定性、证据状态和最小有用下一步/测试。不得仅凭外观、理论评审、ERC/DRC 或制造文件声称板卡已可量产。
