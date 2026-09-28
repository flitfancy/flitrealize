# FlitRealize

**从硬件想法推进到可测试的样机，保留设计依据、验证结果和下一步。**

[English](README.md) · [首次使用](docs/first-run.md) · [更新记录](CHANGELOG.md) · [发布包](https://github.com/flitfancy/flitrealize/releases)

版本标识：`v1.6.0`。当前源码变更见[更新记录](CHANGELOG.md)。

FlitRealize 是一个硬件项目 Skill，覆盖需求、选型、原理图、PCB、制造准备和样机验证。AI 负责工程判断，脚本负责读取、转换、计算、批量执行和回读。每个项目维护一份 `CURRENT_HANDOFF.md`，设计事实分别保存在 Contract、EDA 文件及原始证据中。

## 当前能力

| 阶段 | 支持内容 |
| --- | --- |
| 需求与器件 | 架构、电源和接口关系、器件身份、资料检索与库存匹配 |
| 原理图 | 设计 Contract、库身份核对、批量放件、端点连接、重排、保存与检查 |
| PCB | 布局输入准备、多起点候选、1.5维重力算法与组块形状预生成、局部候选审阅、间距和贴边检查；板框、选定布局写回、线宽、接地及配色工具 |
| 制造与样机 | 输出版本配对、BOM/CPL 交接、测量计划、结果记录和改版依据 |
| 项目续接 | 一份主文稿与 View State 本地面板 |

当前实现 EasyEDA Pro 现场读写；其他软件需要对应 Provider。布线计划尚不是自动布线，布局评分也不等于实际回流、热设计或整板 DRC。各项实现范围随[阶段说明](references/0.0-overview.md)列出。

## 开始使用

安装到宿主的 Skill 目录，使 `flitrealize/` 下直接可见 `SKILL.md`。安装后新开任务：

```text
$flitrealize 从 <PROJECT_ROOT> 开始硬件项目，这次完成需求、架构和器件候选。
```

续接时指定同一项目：

```text
$flitrealize 继续 <PROJECT_ROOT> 的项目，读取当前交接并处理 PCB 布局问题。
```

项目目录与 Skill 分开。安装、脚本环境及 EDA 接入见[首次使用](docs/first-run.md)。

新建项目或首次接管时自动打开 View State，用户可跳过。面板只读展示主文稿，后续更新自动刷新；详细用法见 [View State](view-state/README.md)。

## 结构

| 部分 | 职责 |
| --- | --- |
| `SKILL.md` | 共同工作规则与阶段选择 |
| `references/` | 工程说明、输入约定及专项操作 |
| CLI 与 Action manifest | 查找能力、接收输入、衔接执行和证据 |
| `scripts/`、`schemas/` | 通用计算、校验和 Provider 实现 |

Provider 转换原生身份、层、坐标、引脚映射和网表；传输通道位于 `adapters/`。项目配置和运行证据不写进通用脚本。中文执行说明持续维护，`docs/en-backup/` 是固定历史快照。

## 开发与验证

脚本与面板需要 Node.js 22+；校验和打包需要 Python 3.10+。源码仓库中运行：

```sh
python scripts/validate.py
npm test
python -m unittest discover -s tests -p "test_*.py"
```

发布前的完整本地检查使用 `./scripts/release.ps1 -DryRun`。运行包包含脚本和面板，不包含测试、项目记录或 `node_modules`。实现约定见 [Action 与 Provider 开发](development/action-system.md)。

[MIT](LICENSE) · Copyright (c) 2026 FlitFancy。
