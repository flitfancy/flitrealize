# FlitRealize

**把硬件想法推进到可测试的样机，保留设计依据、结果和下一步。**

[English](README.md) · [首次使用](docs/first-run.md) · [更新记录](CHANGELOG.md) · [发布包](https://github.com/flitfancy/flitrealize/releases)

版本标识：`v2.0.0`。

一个 Skill 覆盖需求、选型、原理图、PCB、制造准备与样机验证。AI 负责工程判断，脚本负责重复计算、执行和回读。项目保持一份 `CURRENT_HANDOFF.md`，Contract、EDA 文件及原始证据保存各自的事实。

## 已实现的工作

| 本次任务 | 能力与范围 |
| --- | --- |
| 需求与器件 | 功能/电源/接口架构、器件身份和资料、复用项目库存工具 |
| 原理图 | Contract 核对、库绑定、批量放件、端点连接、重排与保存检查 |
| 布局 | 统一输入与公共 model；多起点搜索、CP-SAT、开放块、带铜刚性模板、有限形状重力装填及局部比较 |
| 布线 | 角色规则、FR 批次求解与验收/原生执行链；两层 A* 预走线、全层孔位扫描、联合扇出、铜路径、有限回退与清理 |
| PCB 专项操作 | 板框/层/keepout、明确器件移动、指定线段改宽、配色和接地工具 |
| 制造与样机 | 制造候选版本配对、BOM/CPL 和测量/改版的工程指导及证据组织 |
| 续接 | 简短顶部、相关项目正文、只读 View State 面板 |

通用候选和局部诊断保留覆盖范围；地空间是潜在容量模型。完整候选的现场应用走原有执行链，局部/带铜块和细布局候选仍需完整原生计划。实际回流、载流、热和制造结论按相应工程验证取得。

现场 Provider 目前为 EasyEDA Pro：桌面可选官方CLI；网页或明确选用Bridge的桌面使用API Gateway + Node Bridge，由同一 `eda-host.mjs` 选择通道。CLI 的只读 API、会话及原请求查询已实测；其他原生操作按其说明核验代表对象。其他 EDA 须有对应 Provider。

## 开始或继续

安装到宿主 Skill 目录，`flitrealize/` 下直接包含 `SKILL.md`；安装后新开任务：

```text
$flitrealize 从 <PROJECT_ROOT> 开始硬件项目，这次完成需求、架构和器件候选。
$flitrealize 继续 <PROJECT_ROOT>，处理当前 PCB 布局问题。
```

日常读取项目顶部、本次相关章节和当前操作说明。跨阶段或整体设计才查[阶段导航](references/0.0-overview.md)；能力查找见[主入口](SKILL.md#查找能力)，运行依赖与现场通道见[首次使用](docs/first-run.md)。项目目录与 Skill 分开。

新建或首次接管时按需打开 [View State](view-state/README.md)，以后复用；面板显示作者提供的文稿内容和当前通道健康状态，不推断工程进度。

## 架构

| 部分 | 职责 |
| --- | --- |
| `SKILL.md` | 任务范围、续接、能力查找和必要原则 |
| `references/` | 工程阶段、公共输入/算法和操作支持范围 |
| `references/0.3-easyeda-pro.md` | 共同目标、保存回读和未知结果恢复 |
| CLI / manifest | 定位已有能力、接收输入、衔接实现、保留证据 |
| 公共模型与算法 | 派生候选并复用统一约束和验收 |
| Provider / 通道 | 原生身份/层/网表转换与读写；原宿主调度官方 CLI 或 Bridge |

公共算法位于 `scripts/pcb-layout/`、`scripts/pcb-routing/`；原生实现和 CLI 通道在 `scripts/providers/`，Bridge 在 `adapters/`。项目参数与证据留在项目。中文执行文档只有一套；`docs/zh-CN` 是兼容跳转，`docs/en-backup` 是固定历史快照。

## 开发与验证

Node.js 22+；仓库校验/打包脚本可用 Python 3.10+。数值后端需 Python 3.12+ 和[固定依赖](requirements-pcb.txt)，配置见[首跑指南](docs/first-run.md#数值与路由环境)。源码仓库运行：

```sh
python scripts/validate.py
npm test
python -m unittest discover -s tests -p "test_*.py"
```

数值测试需按首跑指南配置解释器；Bridge 集成测试需其通道依赖。完整发布检查使用 `./scripts/release.ps1 -DryRun`。运行包包含工具、参考、依赖清单和面板，排除测试、项目记录及 `node_modules`；实现约定见 [Action 与 Provider](development/action-system.md)。

[MIT](LICENSE) · Copyright (c) 2026 FlitFancy。
