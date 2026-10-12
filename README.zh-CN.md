# FlitRealize

**把硬件想法推进到可测试的样机，留下设计依据、结果和下一步。**

[English](README.md) · [首次使用](docs/first-run.md) · [更新记录](CHANGELOG.md) · [发布包](https://github.com/flitfancy/flitrealize/releases)

一个 Skill 串起需求、器件、原理图、PCB、制造准备和样机测试。AI 负责电路与工程判断，脚本处理重复计算、执行和回读。

版本文件为 `v2.0.0`；当前源码变更和验证结果见 [Unreleased](CHANGELOG.md#unreleased)。

## 开始或继续

将仓库放到宿主的 Skill 目录，确保 `flitrealize/` 下直接有 `SKILL.md`。安装后新开任务：

```text
$flitrealize 从 <PROJECT_ROOT> 开始硬件项目，这次完成需求、架构和器件候选。
$flitrealize 继续 <PROJECT_ROOT>，处理当前 PCB 布局问题。
```

项目与 Skill 分开。每个项目保留一份 `CURRENT_HANDOFF.md`：顶部写当前方案、结果、卡点和下一步，正文保留设计理由及证据入口。实际连接和几何由 Contract、EDA 文件及原始报告保存。

普通续接读项目顶部、本次相关章节和当前操作说明。工作顺序与能力查找见[主入口](SKILL.md)，跨阶段查[阶段导航](references/0.0-overview.md)，依赖和接入见[首次使用](docs/first-run.md)。[View State](view-state/README.md)提供只读项目面板，新建或首次接管时打开，后续复用。

## 工作范围

粗布局安排块，细布局安排簇和器件，走线连接并反馈。按项目当前进度进入相应阶段；字段、命令和支持条件由对应技术参考维护。

当前现场接入是 EasyEDA Pro，支持桌面官方 CLI 与网页／桌面 Bridge；其他 EDA 软件需要对应实现。块区域自动分配、按走线失败自动选器件移动，以及整个流程的自动循环仍待实现。

候选、写入、保存、连通、DRC、电气和样机结果分别记录。二维几何、连接距离或试走线通过，不能代替实际回流、载流、热、机械与制造检查。真实 SDK 位号边界仍待实测；具体限制见[细布局接口](references/technical/pcb-fine-layout-execution.md#验证记录)和[新建 PCB 验证范围](references/providers/easyeda-pro/3.1-pcb-create.md#当前验证范围)，本轮详细变化与回归结果见[更新记录](CHANGELOG.md#unreleased)。

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
