# 首次使用

安装 Skill、指定独立项目目录，再按任务准备运行环境。需求、选型和 Contract 可离线开展；普通续接不重复阅读本页。

## 安装与项目

通过宿主安装器安装，或将仓库放到宿主的 Skill 目录。`flitrealize/` 下直接包含 `SKILL.md`、`references/` 和 `scripts/`，不要再套一层同名目录；安装后新开任务，用 `$flitrealize` 调用。

```text
$flitrealize 在 <PROJECT_ROOT> 开始一个硬件项目，这次完成需求、架构和器件候选。
$flitrealize 继续 <PROJECT_ROOT> 的项目，处理当前 PCB 布局问题。
```

项目设计和证据保存于独立项目目录。文稿格式与面板见 [0.1](../references/0.1-continuation.md) 和 [View State](../view-state/README.md#由-skill-拉起面板)；能力查找、普通续接顺序和授权范围见 [主 Skill](../SKILL.md)。跨阶段或整体设计时才查 [阶段导航](../references/0.0-overview.md)。

## 数值与路由环境

| 本次功能 | 运行依赖 |
| --- | --- |
| 本地 Action、业务 CLI、View State | Node.js 22+ |
| CP-SAT 布局/模板、路径组合选择 | Python 3.12+ 数值环境与 OR-Tools；铜通道快筛另需 NumPy |
| 两层 A*、潜在地空间 | Python 3.12+ 与 NumPy；地连接优化启用时需 OR-Tools |
| FR 寻路 | FR 2.4.1 与 Java 25+，由 [自动布线入口](../references/providers/easyeda-pro/3.8-autorouting.md#fr-运行环境)按需管理 |
| 仓库开发、校验、打包 | Python 3.10+，仅开发任务需要 |

数值依赖固定在 [requirements-pcb.txt](../requirements-pcb.txt)：NumPy 2.5.3、OR-Tools 9.15.6755，需要 Python 3.12+。已有宿主缓存 `runtimes/cpsat` 满足这些版本时直接复用；首次需要时在宿主目录建立独立环境：

```text
python -m venv <HOST_NUMERIC_RUNTIME>
<该环境的python> -m pip install --only-binary=:all: -r <skill>/requirements-pcb.txt
```

第一行选择已安装的 Python 3.12+。Windows 环境解释器位于 `Scripts/python.exe`，其他平台通常为 `bin/python`。公开入口用 `--python <解释器>` 或 `FLITREALIZE_PCB_PYTHON`；布局后端模块也可用 `FLITREALIZE_CPSAT_PYTHON`。源码数值测试另读取 `FLITREALIZE_CPSAT_PYTHON` 与 `PCB_PREROUTE_PYTHON`。文档任务不安装数值环境。

依赖保存在宿主运行目录，不写入项目 Contract，不把某台机器的路径、JRE、JAR 或虚拟环境打进 Skill。查到可执行文件或模块不等于本次算法与工程检查已通过。

首次使用数值入口时，可按需跑 [open最小示例](../references/3.4-block-layout.md#最小运行示例) 或 [预走线最小示例](../references/3.8-prerouting.md#最小运行示例)；普通续接不重跑样例。

## 现场执行通道

目前现场 Provider 为 EasyEDA Pro。桌面客户端有可用 CLI 时先 `doctor`，然后复用会话；通道由原宿主的 `--channel cli|bridge`、`--cli-executable PATH` 或相应环境配置选择，见 [0.3 通道与共同执行规则](../references/0.3-easyeda-pro.md#选择执行通道)。高层业务 CLI 使用原参数，不直接加上述宿主选项。

网页版或明确使用 API Gateway + Node Bridge 时，按 [0.4 网页 Bridge](../references/providers/easyeda-pro/0.4-environment.md)准备与复用连接；它不是客户端 CLI 的固定前置。仓库不包含 EDA 客户端或 Gateway 扩展。CLI doctor/会话探测不能替代原生写入、保存和 DRC 验证。

## 出现问题时

| 现象 | 按需入口 |
| --- | --- |
| 宿主找不到 Skill | 核对目录直接包含 `SKILL.md`，再新开任务 |
| Node 或数值依赖缺失 | 按上表只准备本次功能需要的环境 |
| CLI doctor/会话失败 | 查看原宿主状态与客户端错误，先修复对应通道 |
| Bridge/网关不可用 | [0.4](../references/providers/easyeda-pro/0.4-environment.md) |
| 写入终态或保存状态未明 | [0.3 恢复规则](../references/0.3-easyeda-pro.md#失败与恢复) |
| 布局输入缺项或冲突 | 本次 `summary.json`、`diagnostics.json`；修改拥有事实的上游数据或项目规则 |

补充原生 API 调用时再读 [0.3 API 说明](../references/0.3-easyeda-pro.md#api-与完成范围)，开发工具时再读 [Action 与 Provider](../development/action-system.md)。
