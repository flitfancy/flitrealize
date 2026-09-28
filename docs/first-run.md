# 首次使用

先安装 Skill、指定独立项目目录，再按任务决定是否连接 EDA。需求、选型和 Contract 可离线开展；脚本与 View State 需要 Node.js 22+。仓库开发、校验和打包另需 Python 3.10+。

## 安装

通过宿主的 Skill 安装器安装本仓库，或将仓库放到宿主的 Skill 目录。常见位置为 `$HOME/.agents/skills/flitrealize`，具体以宿主设置为准。

`flitrealize/` 下应直接包含 `SKILL.md`、`references/` 和 `scripts/`，不要多套一层同名目录。安装后新开任务，用 `$flitrealize` 调用。

项目文件放在独立目录；Skill 中保存通用工具和规则，项目中保存设计、现场文件与证据。

## 第一次项目任务

例如：

```text
$flitrealize 在 <PROJECT_ROOT> 开始一个硬件项目。
这次完成需求、架构和器件候选。
```

应在项目中形成一份 `CURRENT_HANDOFF.md`：顶部是当前目标和下一步，正文保留设计依据和已确认结果。已有项目则继续读写同一份主文稿：

```text
$flitrealize 继续 <PROJECT_ROOT> 的项目，先读取当前交接，再处理其中的 PCB 布局问题。
```

新建项目或首次接管时，Skill 会自动打开 View State；明确表示不需要即可跳过。面板只读展示主文稿，启动失败不影响其他工作。[面板启动与端口](../view-state/README.md)。

## 找到可用操作

下列查询只读本地文件，不连接 EDA：

```text
node <skill>/scripts/action-runner.mjs list --domain schematic --query "放件"
node <skill>/scripts/action-runner.mjs list --domain pcb --query "布局"
```

按查询结果的入口和专项说明执行。布局求解先整理上游设计与 PCB 现场，再生成候选；运行和支持范围见 [3.4 布局](../references/providers/easyeda-pro/3.4-pcb-placement.md)，配置输入时再读[布局输入](../references/pcb-layout-inputs.md)。

开发原生调用或核查接口时，可以定向查询随 Skill 附带的历史 API 文档：

```text
node <skill>/scripts/api-reference.mjs search --query "焊盘" --kind method --limit 8
node <skill>/scripts/api-reference.mjs show --id "PCB_PrimitiveComponent#getAllPinsByPrimitiveId"
```

文档查询不执行示例。新调用仍需核对官方资料和实际编辑器支持，不能把历史签名当成现场验证。

## 连接 EasyEDA Pro

目前只有 EasyEDA Pro 的现场实现。仓库包含连接通道源码，不包含 EDA 客户端和 API Gateway 扩展。

需要读取或修改真实 EDA 文档时，按 [0.4 环境与连接](../references/providers/easyeda-pro/0.4-environment.md)安装通道依赖、注册并确认目标窗口。已可用的连接继续复用。首次批量操作先核对代表对象，结果分别说明回读、保存和检查范围。

其他 EDA 须接入相应 Provider 的数据转换与执行能力；更换软件名称不会自动获得支持。开发边界见 [Action 与 Provider](../development/action-system.md)。

## 遇到问题

| 现象 | 下一步 |
| --- | --- |
| 宿主找不到 Skill | 检查安装目录是否直接包含 `SKILL.md`，然后新开任务 |
| `node` 不存在或版本过旧 | 安装 Node.js 22+；纯文档设计仍可继续 |
| 能列出操作，但 EDA 调用失败 | 按 [0.4](../references/providers/easyeda-pro/0.4-environment.md)核对客户端、网关、通道和窗口 |
| 写入超时或结果未知 | 读取原请求记录并核对现场，不直接重发；见 [Provider 恢复](../references/0.3-easyeda-pro.md#失败与恢复) |
| 布局输入有缺项或冲突 | 查看该次 `summary.json` 与 `diagnostics.json`，修正拥有该事实的上游数据或项目规则 |

首跑以后，从 [阶段地图](../references/0.0-overview.md)进入当前工作，不必重复通读安装说明。
