# FlitRealize

**从需求与器件选择推进到原理图、PCB、制造准备和样机验证。**

[English](README.md) · [首次使用](docs/first-run.md) · [更新记录](CHANGELOG.md) · [发布包](https://github.com/flitfancy/flitrealize/releases)

FlitRealize 是用于推进电子硬件项目的 Skill。可以从项目当前阶段开始，保留设计依据、实际结果和待解决问题，方便继续推进。

当前发行版为 `v2.1.0`；变更和验证结果见[发行说明](CHANGELOG.md#210---2026-10-12)。

## 开始或继续

将仓库放到宿主的 Skill 目录，确保 `flitrealize/` 下直接有 `SKILL.md`。安装后新开任务：

```text
$flitrealize 从 <PROJECT_ROOT> 开始硬件项目，这次完成需求、架构和器件候选。
$flitrealize 继续 <PROJECT_ROOT>，处理当前 PCB 布局问题。
```

项目与 Skill 分开。每个项目保留一份 `CURRENT_HANDOFF.md`：顶部写当前方案、结果、卡点和下一步，正文保留设计理由及证据入口。实际连接和几何由 Contract、EDA 文件及原始报告保存。

普通续接读项目顶部、本次相关章节和当前操作说明。工作顺序与能力查找见[主入口](SKILL.md)，跨阶段查[阶段导航](references/0.0-overview.md)，依赖和接入见[首次使用](docs/first-run.md)。[View State](view-state/README.md)提供只读项目面板，新建或首次接管时打开，后续复用。

## 工作范围

覆盖需求与器件选择、原理图设计、PCB 布局与走线、制造准备，以及样机上电、功能测试和改版。AI 负责电路与工程判断；已有脚本处理重复检索、转换、放置、连接和回读。

当前支持 EasyEDA Pro（嘉立创 EDA 专业版），通过桌面官方 CLI 或网页／桌面 Bridge 操作 EDA 项目。按用户本次要求推进，分别记录候选、实际修改、保存和验证结果。

工作流程见[阶段导航](references/0.0-overview.md)。具体算法、命令、支持条件和验证边界见[技术参考目录](references/technical/)。

## 开发与验证

Node.js 22+；仓库校验和打包使用 Python 3.10+。数值后端需要 Python 3.12+ 与[固定依赖](requirements-pcb.txt)，配置见[首次使用](docs/first-run.md#数值与路由环境)。在源码目录运行：

```sh
python scripts/validate.py
npm test
python -m unittest discover -s tests -p "test_*.py"
```

数值测试需要已配置的解释器，Bridge 集成测试需要通道依赖。`./scripts/release.ps1 -DryRun` 运行仓库、回归和干净 ZIP 检查。开发约定见 [Action 与 Provider](development/action-system.md)。

中文执行说明只有一套；`docs/zh-CN` 保留兼容跳转，`docs/en-backup` 保留固定历史快照。运行包包含工具、说明、依赖清单和面板，项目记录、测试及依赖安装目录留在包外。

[MIT](LICENSE) · Copyright (c) 2026 FlitFancy.
