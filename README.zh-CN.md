# FlitRealize

**从硬件想法推进到可测试的样机，让设计、验证和下一步在不同任务之间持续衔接。**

[English](README.md) · [首次使用](docs/first-run.md) · [View State 可视化](view-state/README.md) · [更新记录](CHANGELOG.md)

FlitRealize 是一个覆盖需求、器件、原理图、PCB、制造准备与样机验证的智能体 Skill。它把工程设计说明、可复用的 EasyEDA Pro 操作和 **View State 本地交接面板**放在同一个仓库中。

每个项目维护一份 `CURRENT_HANDOFF.md`：顶部说明当前目标和下一步，正文保留设计理由、约束、资料来源与验证结果。每次只推进你要求的阶段，并把后续工作需要的上下文留在项目里。

> **当前版本：`v1.3.1`**，新建项目或首次接管项目时自动打开 View State，包含 v1.3.0 引入的面板和 PCB 配色流程。[下载运行包](https://github.com/flitfancy/flitrealize/releases/tag/v1.3.1) · [发布说明](CHANGELOG.md#131---2026-09-20)。

## 能做什么

| 范围 | 当前支持的工作 |
| --- | --- |
| 需求与器件 | 架构、接口、电源关系、器件身份、手册资料与库存匹配 |
| 原理图 | 可移植设计 Contract、引脚网络检查、批量放件、连接、重排和回读 |
| PCB | 板框、布局候选、间距、指定线段改宽、接地工具与网络类配色 |
| 制造与样机 | 源文件和输出对齐、BOM/CPL 交接、测量记录、未决事项与改版决定 |
| 项目续接 | 一份项目主文稿、派生事实表，以及区分历史证据和当前验证的检查 |
| View State | 阶段导航、人工编写的梗概、交接原文阅读、中英切换与本机桥接状态 |

当前已实现的 EDA Provider 是 EasyEDA Pro。没有 EDA 客户端时，也能完成需求、选型、计算与原理图设计 Contract；操作真实 EDA 文档时，需要客户端、API Gateway 和仓库内的 Adapter 通道，详见[首次使用说明](docs/first-run.md)。

布线计划整理顺序和约束，不代表自动布线器已经执行。样机验证仍需要实物与仪表。计划、EDA 回读、保存、DRC 和实测结果分别记录，不混用为“已完成”。

## 开始使用

通过宿主的 Skill 安装器安装本仓库，或将仓库 clone 到宿主 Skill 目录，使 `flitrealize/` 下直接可见 `SKILL.md`。常见位置为 `$HOME/.agents/skills/flitrealize`。安装后新开任务，使用 `$flitrealize` 调用。

开始新项目：

```text
$flitrealize 从 <PROJECT_ROOT> 开始一个硬件项目。
这次完成需求、架构和器件候选。
把设计说明与下一步写入 CURRENT_HANDOFF.md。
```

继续现有项目：

```text
$flitrealize 继续 <PROJECT_ROOT> 的硬件项目。
读取 CURRENT_HANDOFF.md，处理其中记录的 PCB 布局问题。
同步更新受影响的设计章节和 ViewState 梗概。
```

项目目录与 Skill 仓库分开。[音频系统](references/domains/D.1-audio-systems.md)等专项知识按项目需要加载。

## View State 可视化

View State 位于本仓库的 **`view-state/`**，也随之后构建的运行 ZIP 一起分发。需要 Node.js 22+ 和浏览器，没有第三方 npm 运行依赖，无需构建。

新建项目或首次接管已有项目时，Skill 确认项目目录后会主动打开面板，优先复用已有服务。明确表示不需要面板时跳过；面板启动失败不阻塞硬件工作。后续操作更新主文稿，不重复打开页面。

也可以直接让 Skill 打开：

```text
$flitrealize 为 <PROJECT_ROOT> 打开 View State。
```

也可以在仓库或解压后的 Skill 根目录运行，将 `<PROJECT_ROOT>` 替换为项目绝对路径：

```sh
node view-state/server.mjs --project-root "<PROJECT_ROOT>"
```

打开 [127.0.0.1:49700](http://127.0.0.1:49700)。小窗提供阶段导航、项目切换、中英文界面、手动刷新与前台每五秒刷新；从梗概进入原文时，会定位到对应标题。

Skill 在主文稿中编写 `ViewState:` 段落，面板按原文展示。缺少梗概或工程状态时明确显示未提供；桥接连接只表示本机连接情况，不代表设计已通过验证。面板只读取项目文件，不回写工程内容。

需要 JSON 输出时运行：

```sh
node view-state/cli.mjs --project-root "<PROJECT_ROOT>"
```

启动步骤、端口设置与梗概约定见 [View State 说明](view-state/README.md)。

## 当前 PCB 配色流程

上层明确已有网络类的完整成员和信号用途 `kind`，也可提供显式 `#RRGGBB` 色值。固定用途覆盖电源、地、逻辑供电、I2C、SPI、UART 及常用控制信号；相同 kind 跨项目使用相同颜色。

`pcb-routing-plan` 可对照输入的实际 PCB 网络清单检查覆盖范围，并生成配色请求；`pcb-edit` 衔接计划与执行，在执行内完成规则保留、回读和保存。着色模块不猜用途、不创建或拆分网络类。旧配色指纹计划及独立 verify/save 请求需要改为重新生成计划。

操作说明分为 [3.4 布局与空间](references/providers/easyeda-pro/3.4-pcb-placement.md)、[3.5 布线规则](references/providers/easyeda-pro/3.5-pcb-routing-plan.md)、[3.6 线宽调整](references/providers/easyeda-pro/3.6-pcb-trace-width.md)、[3.7 网络配色](references/providers/easyeda-pro/3.7-pcb-net-color.md)，按任务读取。每份说明包含执行边界和交接写回要求；View State 保留布局项，将规则、改宽和配色合为“网络规则”表，显示网络名称、线宽及实际色值圆点。表格与来源说明写在同一份主文稿中，区分计划与回读结果；未知颜色显示“—”。

## 开发与验证

中文 `SKILL.md`、`references/` 和 `development/` 是唯一维护的执行源。英文首页用于介绍项目；`docs/en-backup/` 保存固定历史快照，`docs/zh-CN/` 保留旧链接跳转。

```text
flitrealize/
├── SKILL.md           Skill 入口与阶段路由
├── references/        阶段、Provider 和专项参考
├── adapters/          EasyEDA Pro 桥接通道
├── schemas/           可移植原理图 Contract
├── scripts/           Action、交接工具、校验与打包
├── view-state/        本地面板、原文阅读、CLI 与测试
├── tests/             Action 和发布工具回归测试
├── development/       开发与 Action 系统说明
└── docs/              首次使用与历史文档
```

工具与面板需要 Node.js 22+；仓库校验和打包还需要 Python 3.10+。在源码仓库运行：

```sh
python scripts/validate.py
npm test
python -m unittest discover -s tests -p "test_*.py"
```

`npm test` 统一执行 Skill 和 View State 测试。完整 PowerShell 检查还会验证确定性打包及干净 ZIP 解压后的实际运行：

```powershell
./scripts/release.ps1 -DryRun
```

运行包包含面板及静态资源，不包含测试、英文历史备份、本地项目记录、下载的安装包或 `node_modules`。这些检查本身不会发布新版本。

## 许可证

[MIT](LICENSE) · Copyright (c) 2026 FlitFancy。
