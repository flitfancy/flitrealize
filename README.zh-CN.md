# FlitRealize

[English](README.md)

FlitRealize 是一个面向完整硬件项目的 Skill，用来把想法持续推进到可测试的实物。

中文是唯一维护和执行语言：修改根目录 [SKILL.md](SKILL.md)、`references/` 和 `development/` 中的中文说明。`docs/en-backup/` 是切换前的固定英文备份，不参与执行、不要求随中文同步；旧 `docs/zh-CN/` 只保留跳转。脚本、命令、API 和机器字段名不翻译。

每个项目使用一个 `CURRENT_HANDOFF.md` 作为人类主文稿，把需求、器件、原理图、PCB、制造和样机结果保存在同一条项目主线上。Contract、EDA 和制造文件继续保存对应的机器事实。

> 当前正式版本：**FlitRealize `v1.1.0`**。变化见[发布说明](CHANGELOG.md#110---2026-09-14)；首次安装与冷启动见[首次使用说明](docs/first-run.md)。

## 它能做什么

```text
想法和需求
    → 架构、接口和器件意图
    → 器件解析与确认
    → 原理图设计
    → EDA 原理图
    → PCB 约束、布局和布线
    → 制造文件与下单
    → 样机上电和测试
    → 改版
```

FlitRealize 理解完整流程，但每次只推进用户当前要求的阶段。

它适合：

- 从需求和架构开始的新硬件项目；
- 继续完成原理图、PCB、制造或样机验证的现有项目；
- 需要在不同任务之间保持连续设计状态的项目；
- 能够从器件资料、库存和 EDA 自动化中获益的工作。

它不用于纯软件工作、孤立器件知识、教材问题，或不需要项目上下文的一步式 EDA 问题。

## 项目主文稿

`CURRENT_HANDOFF.md` 从项目开始持续更新，包括：

- 当前目标、阶段和下一步；
- 需求、架构、接口和电源树；
- 器件选择和资料状态；
- 原理图分块、引脚网络、计算和测试点；
- PCB 约束、布局布线和制造状态；
- 样机结果、改版决定和当前未决事项。

普通续接先读取顶部当前交接和本次相关章节。只有接管缺少主文稿的旧项目、发生全局变化或发现实际冲突时，才重新检查整个项目。

文稿可以较长：顶部摘要短，正文按稳定章节保留设计理由、限制、物理引脚/网络表，以及 PCB 功能块的成员、位置和布局理由。机器文件仍是各自事实的来源，主文稿提供可读视图，不退化成文件链接清单，也不为每个阶段另建一份交接。具体结构见 [0.1](references/0.1-continuation.md)。

## 它怎样工作

### 默认直接推进

普通项目工作直接完成当前阶段需要的内容。不会影响当前设计的缺口可以转成明确的样机测试，不把每个任务扩展成正式评审。

### 只在必要位置深入

`CURIOUS_MODE` 是局部深入核验。

只有准确型号、引脚、封装、关键行为、曲线、温升、保护功能或资料冲突确实影响当前判断时才进入。问题确认或转成具体测试后，继续普通工作。

### AI 做判断，脚本做重复工作

AI 负责需求、架构、电路、关键计算、器件判断和跨阶段整理。

脚本负责：

- 资料检索和下载；
- 本地缓存和库存匹配；
- 格式转换和去重；
- Contract 检查；
- 重复 EDA 操作。

自动化服务于设计，不代替设计判断。

## 三个主要阶段

### 1. 设计与原理图

把产品想法整理成需求、架构、接口、电源关系、器件决定和完整原理图设计。

进入 EDA 前，确认影响器件身份、引脚、额定值、连接和保护行为的关键事实。

### 2. PCB 与制造准备

确定板框、接口、层叠、网络规则和关键布局关系，再完成布局、布线、铺铜和 DRC。

准备制造时，让当前源文件、Gerber、钻孔、BOM、CPL 和板厂预览保持一致。

### 3. 样机验证与改版

检查实物和未上电电源轨，再限流上电。先确认电源轨，然后逐步启用功能，并测试当前产品需要的负载、上下电和故障行为。

测量结果用于确认当前设计或形成下一版修改。

## 器件和 EDA

器件意图和原理图设计与具体 EDA 平台分开。

电气身份、制造商型号、采购身份、资料依据以及 EDA 符号和封装绑定是相关但不同的事实。

EasyEDA Pro 是当前已经实现的 EDA Provider，但不是使用 FlitRealize 的前提。没有 EasyEDA 时，项目仍然可以完成需求、架构、器件选择、计算和原理图 Contract。

## 开始使用

详细冷启动、环境分层与 EDA 接入见 [docs/first-run.md](docs/first-run.md)。摘要如下。

可以让 `$skill-installer` 从 GitHub 仓库安装，也可以把仓库放到：

```text
$HOME/.agents/skills/flitrealize
```

之后使用 `$flitrealize`。

开始新项目：

```text
$flitrealize 从 <PROJECT_ROOT> 的空白项目开始设计。
当前只完成需求、架构和器件候选，在我审阅前不要写入 EDA。
```

继续现有项目：

```text
$flitrealize 继续 <PROJECT_ROOT> 的硬件项目。
读取 CURRENT_HANDOFF.md，然后完成我这次要求的设计工作。
```

只处理一个阶段：

```text
$flitrealize 检查当前原理图，只处理会改变连接、额定值、保护行为或样机结果的问题。
```

下单、付款、预留库存或其他新的外部承诺，需要用户对该动作明确授权。

## 仓库结构

```text
flitrealize/
├── SKILL.md            # 中文执行入口和全流程路由
├── docs/first-run.md   # 首次使用与冷启动
├── references/         # 中文阶段和 Provider 执行说明
├── adapters/
│   └── easyeda-pro/    # 内嵌 EasyEDA Pro 通道（Bridge）
├── development/        # 中文 Action 与 Provider 开发说明
├── schemas/            # 可移植机器 Contract
├── scripts/            # Action、器件工具、校验和打包
│   ├── actions/
│   └── parts/
├── tests/
└── docs/
    ├── en-backup/      # 固定英文快照（.bak），不参与执行
    └── zh-CN/          # 旧链接兼容跳转，不维护第二份正文
```

开发和修改仓库时运行：

```powershell
python scripts/validate.py
npm test
./scripts/release.ps1 -DryRun
```

发布流程生成可复现 ZIP 和 SHA-256 文件，运行包使用原路径的中文执行说明，不包含英文备份。英文快照按原始 SHA-256 校验；修改中文不需要同步英文，也不要刷新备份哈希。旧 `scripts/update_translation_hashes.py` 已停用。

## 许可证

FlitRealize 使用 [MIT License](LICENSE) 发布。Copyright (c) 2026 FlitFancy。
