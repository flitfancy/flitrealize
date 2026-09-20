# FlitRealize 首次使用说明

本文只回答「刚拿到这个 Skill 时，怎样跑通第一段工作」。阶段细节不在此重复；执行规则仍以 [SKILL.md](../SKILL.md) 和 `references/` 为准。

中文是唯一维护语言。命令、路径和字段名保持原样。

## 30 秒判断

先确认你这次要什么：

| 你要做的事 | 需要 EDA 客户端 | 需要本机 Adapter | 刚 clone 后能否开始 |
| --- | --- | --- | --- |
| 需求、架构、电源树、接口 | 否 | 否 | 能 |
| 器件选型、身份确认、读手册 | 否 | 否 | 能（取资料时需要网络） |
| 原理图 Contract、引脚网络意图 | 否 | 否 | 能 |
| 查看 / 创建 / 修改真实 EDA 文档 | 是 | 是 | 不能，先完成 [接入 EDA](#接入-eda) |
| 制造文件、样机上电与改版记录 | 否（设计侧） | 否 | 能；实物步骤依赖你的硬件与仪表 |

**关键事实：**

1. 本仓库是硬件全流程 Skill，**不包含**任何 EDA 客户端；当前 Provider 的**通道源码**内嵌在 `adapters/easyeda-pro/`。
2. 需求 / Contract / 主文稿与具体 EDA 平台无关；写入或回读真实 EDA 文档时，才需要「通用宿主接口 + 当前 Provider 实现」。
3. 当前唯一已实现的 Provider 是 **EasyEDA Pro**；接口本身按可替换 Provider 设计，不是写死嘉立创。

## 查看项目交接（View State）

从 v1.3.0 开始，源码和运行 ZIP 均内置 `view-state/`。需要 Node.js 22+ 和浏览器，无需 npm 安装或连接 EDA。

可以直接要求 `$flitrealize 为 <项目绝对路径> 打开 View State`，或在 Skill 根目录运行：

```sh
node view-state/server.mjs --project-root "<项目绝对路径>"
```

打开 [127.0.0.1:49700](http://127.0.0.1:49700)，查看阶段导航、`ViewState:` 梗概和交接原文。梗概由 Skill 写入项目 `CURRENT_HANDOFF.md`，面板只读展示；没有梗概时可以继续阅读原文。服务复用和完整步骤见 [View State](../view-state/README.md)。

## 接口分层（先看懂这个）

```text
flitrealize 本体（EDA 无关）
  SKILL / references / Contract / 阶段流程
  action-runner.mjs
  eda-host.mjs                 ← 通用本机宿主契约
           │  register / status / ensure / execute / request
           │  统一参数：--eda, --adapter-root, --code-file, --request-id, …
           ▼
  各 EDA 的本机 Adapter（可替换，一机可注册多个）
           │
     ┌─────┴─────┐
     ▼           ▼
 easyeda-pro    其他 Provider
 （已实现）      （未实现，需另做 Adapter）
```

| 层 | 是否绑定某一 EDA | 你现在会碰到的内容 |
| --- | --- | --- |
| Contract、主文稿、阶段文档 | 否 | 与平台无关 |
| `eda-host.mjs` 与 host profile | 否 | 本机注册表；`--eda` 从 manifest 的 providers 推导 |
| Adapter 控制契约 `scripts/bridge-control.mjs` | 否 | 所有 Provider 都必须实现的 CLI 形状 |
| 当前 EasyEDA Pro 实现 | 是 | 内嵌通道 `adapters/easyeda-pro/`、API Gateway、`scripts/actions/easyeda-pro/*` |

结论：**万能接口 = flitrealize 的 host 契约 + Action 运行时；嘉立创只是第一个 Provider 实现。** 冷启动时，通用步骤与 Provider 专属步骤要分开做。

## 你实际要准备什么

按目标分层准备，不必一次配齐。

### A. 只用 Skill 做离线设计

1. 能加载 Skill 的智能体宿主（见下节安装路径）。
2. 一个**独立的项目根目录**（不是 Skill 仓库目录）。`CURRENT_HANDOFF.md` 建在项目里，不建在 Skill 里。
3. 宿主能读文件、写项目目录，并和你对话。

不需要 Node、Python、任何 EDA。

### B. 要跑 Skill 自带脚本

在 A 的基础上增加：

1. **Node.js ≥ 22**（`package.json` 的 `engines` 要求；脚本使用 ESM、top-level await 和内置 `fetch`）。
2. 宿主能执行 shell / PowerShell，并允许运行 `node <skill>/scripts/...`。

常用入口（只读发现，不连 EDA）：

```text
node <skill>/scripts/action-runner.mjs list --domain schematic --query <用途短词>
node <skill>/scripts/action-runner.mjs list --domain pcb --query <用途短词>
node <skill>/scripts/action-runner.mjs list --domain system
node <skill>/scripts/parts/parts-resolver.mjs --help
node <skill>/scripts/handoff-check.mjs inspect --project-root <项目绝对路径>
```

### C. 要连当前 Provider（EasyEDA Pro）做自动化

在 B 的基础上，分两段：**通用宿主** + **EasyEDA Pro 实现**。

#### C1. 通用宿主（与具体 EDA 无关）

任何 Provider 都走同一套本机注册：

```text
node <skill>/scripts/eda-host.mjs register \
  --eda <provider-id> \
  --adapter-root <adapter-root>
```

注册条件：`<adapter-root>` 是完整安装根目录，且同时存在：

- `package.json`
- `scripts/bridge-control.mjs`（实现 `status` / `ensure` / `execute` / `request` 等）

已注册则不要重复注册。本机状态默认写在用户配置目录（Windows 为 `%LOCALAPPDATA%\FlitRealize\host.json`，可用 `FLITREALIZE_HOME` 覆盖），**不写入项目 Contract**。

当前 manifest 里已登记的 Provider id 只有 `easyeda-pro`。

#### C2. EasyEDA Pro 实现（当前唯一 Provider）

1. **EasyEDA Pro** 桌面客户端（嘉立创 EDA 专业版），并打开目标原理图 / PCB 文档。
2. **API Gateway 扩展**（装进 EasyEDA Pro，不是 npm 包）：
   - 扩展市场：`https://jlcext.com`
   - 或 Pro 内 **扩展管理 / Extension Manager** 在线搜索 / 导入 `.eext`
   - 启用扩展，并打开 **外部交互** 权限，否则本地 Bridge 连不上
3. **内嵌 Adapter 通道**（随本仓库发布）：

```text
<skill>/adapters/easyeda-pro/
├── package.json
├── package-lock.json
└── scripts/
    ├── bridge-control.mjs
    ├── bridge-server.mjs
    └── request-store.mjs
```

首次安装依赖并注册（默认使用树内路径）：

```text
cd <skill>/adapters/easyeda-pro
npm install

node <skill>/scripts/eda-host.mjs register \
  --eda easyeda-pro \
  --adapter-root <skill>/adapters/easyeda-pro

node <skill>/scripts/eda-host.mjs ensure \
  --eda easyeda-pro \
  --require-eda
```

业务 Action 仍在 `scripts/actions/easyeda-pro/`；内嵌目录只负责连接与执行通道。完整 API 资料与独立使用方式见上游 [easyeda-api-skill](https://github.com/easyeda/easyeda-api-skill)。

## 安装 Skill

目标：让宿主智能体能加载本仓库根目录的 `SKILL.md`。

可选方式：

1. 若宿主提供 `$skill-installer` 或同等安装器，从 GitHub 仓库安装。
2. 或把本仓库放到宿主的 Skill 目录。常见位置：

| 宿主 | 典型路径 |
| --- | --- |
| Claude Code / 部分 Agent 约定 | `$HOME/.agents/skills/flitrealize` 或 `~/.claude/skills/flitrealize` |
| MiMo Desktop（全局） | `~/.config/mimocode/skills/flitrealize` |
| MiMo Desktop（仅当前项目） | `<项目>/.mimocode/skills/flitrealize` |

目录名建议为 `flitrealize`，其中直接可见 `SKILL.md`、`scripts/`、`references/`。

安装后**新开对话**再调用，避免宿主仍使用旧的 Skill 缓存。调用名以宿主展示为准，常见为 `$flitrealize`。

验证安装是否成功：让智能体执行 Skill 列表查找，或直接发起下面的「离线首跑」；若完全读不到 `SKILL.md`，先检查路径层级（不要多套一层 `flitrealize/flitrealize`）。

## 离线首跑（推荐先做这个）

目的：确认 Skill 能加载、项目目录可用、主文稿能建立，且不依赖 EDA。

### 1. 准备项目根目录

任选一个空目录或已有硬件项目目录，例如：

```text
/path/to/my-board
```

不要使用 Skill 仓库自身作为项目根。

### 2. 用一句话交代范围

对智能体说（或按宿主习惯改成 `$flitrealize ...`）：

```text
在 <PROJECT_ROOT> 开始一个新硬件项目。
当前只做需求、架构和器件候选。
不要连接 EDA，不要写入 EasyEDA。
完成后把当前目标和下一步写入 CURRENT_HANDOFF.md 顶部。
```

### 3. 你应该看到什么

- 项目根下出现或更新了 `CURRENT_HANDOFF.md`；
- 顶部有简短当前交接（目标、阶段、下一步）；
- 正文保留需求 / 架构 / 器件等可续写章节；
- 明确没有声称已经改过 EasyEDA。

到这一步，首次使用已经跑通。之后续接应先读同一份主文稿顶部，而不是每次从零重开项目。

### 续接已有项目

```text
继续 <PROJECT_ROOT> 的硬件项目。
读取 CURRENT_HANDOFF.md 顶部交接和本次相关章节，只完成我这次要求的工作。
```

## Adapter 与当前 Provider

### 通用 Adapter 契约（万能接口的一半）

flitrealize 不关心 Adapter 内部怎么连 EDA，只要求一个本机目录满足：

```text
<adapter-root>/
├── package.json
└── scripts/
    └── bridge-control.mjs
```

`eda-host.mjs` 以子进程方式调用：

```text
node <adapter-root>/scripts/bridge-control.mjs <status|ensure|windows|select|execute|request> --json ...
```

`execute` 时，flitrealize 把已登记的 Action 源文件作为 `--code-file` 传入；Adapter 负责在真实 EDA API 环境中执行，并以 JSON 行返回结果与请求句柄。  
因此：**换一个 EDA = 换一个实现同一契约的 Adapter + 在 manifest 登记新 provider**，不必改 `eda-host.mjs`。

### 当前实现：EasyEDA Pro

| 问题 | 答案 |
| --- | --- |
| Provider id | `easyeda-pro` |
| 通道位置 | 本仓库内嵌：`adapters/easyeda-pro/` |
| 角色 | 实现通用 `bridge-control`，并驱动 EasyEDA Pro 本地 Bridge / API |
| 业务 Action | 仍在 `scripts/actions/easyeda-pro/`，不塞进通道目录 |
| 不是什么 | 不是嘉立创官网「桥接服务」安装包；不负责电路与布局判断 |
| 与嘉立创的关系 | 目标软件是嘉立创 EDA **专业版**；经 API Gateway + 本地 Bridge 调用原生 API（`sch_*` / `pcb_*` / `sys_*` 等） |

```text
智能体 / flitrealize Action（scripts/actions/easyeda-pro/*）
        ↓
flitrealize/scripts/eda-host.mjs                 ← 通用
        ↓
adapters/easyeda-pro/scripts/bridge-control.mjs  ← 内嵌通道
        ↓  本地 WebSocket Bridge（默认端口 49620–49629）
EasyEDA Pro + API Gateway 扩展                   ← 嘉立创客户端
```

## 接入 EDA

仅当任务需要查看或修改真实 EDA 文档时进行。下列步骤默认针对当前 Provider `easyeda-pro`。

### 接入前检查

```text
node -v
node <adapter>/scripts/bridge-control.mjs status --json
node <skill>/scripts/eda-host.mjs status --eda easyeda-pro
```

- `node -v`：flitrealize 脚本要求 ≥ 22。
- Adapter `status` 可先于注册运行，用来确认控制入口与依赖是否齐全。
- `eda-host status` 报未注册 = 还缺通用宿主注册，不是 Skill 没装好。

### 接入顺序

1. 安装并启动 EasyEDA Pro。
2. 从嘉立创扩展市场（`https://jlcext.com`）或 Pro 内「扩展管理」安装并启用 **API Gateway**，打开外部交互权限。
3. 打开正确项目与原理图 / PCB 文档。
4. 在 `<skill>/adapters/easyeda-pro` 执行 `npm install`（首次）。
5. `eda-host.mjs register --eda easyeda-pro --adapter-root <skill>/adapters/easyeda-pro`（仅未注册时）。
6. `ensure --require-eda`，确认连接与目标窗口。
7. 再执行需要 EDA 的任务；首次批量操作前先用代表对象验证。

详细连接、失败分层和中断请求查询见 [0.4 环境与连接](../references/providers/easyeda-pro/0.4-environment.md)。  
Bridge 迟到结果与恢复见 Adapter 内 `references/bridge-recovery.md`。  
操作入口先查：

```text
node <skill>/scripts/action-runner.mjs list --domain schematic --query "放件"
node <skill>/scripts/action-runner.mjs list --domain pcb --query "线宽"
```

### 明确不在 flitrealize 仓库内的东西

- 任意 EDA 客户端与其扩展（当前：EasyEDA Pro、API Gateway）
- Bridge 运行时会话状态（token、request 记录；落在本机状态目录）
- 你的项目文件、库文件、制造输出
- 共享器件资料库（`parts-resolver` 需要你指定 `--database-root`）

内嵌的只有 Adapter **源码通道**；完整 API 类文档与独立 Skill 形态仍在上游 `easyeda-api-skill`。

器件资料解析示例（需要网络；本地已有记录时不访问网络）：

```text
node <skill>/scripts/parts/parts-resolver.mjs \
  --project-root <项目> \
  --database-root <你的资料库目录> \
  --input <项目内 parts.json>
```

## 卡住时对照

| 现象 | 优先判断 | 处理 |
| --- | --- | --- |
| 宿主找不到 Skill / `$flitrealize` | 安装路径或缓存 | 核对是否直接包含 `SKILL.md`；新开对话 |
| 要求「项目目录」却指向了 Skill 仓库 | 项目根与 Skill 根混淆 | 换成独立项目根，主文稿写在项目里 |
| `node` 不是命令或脚本语法报错 | Node 版本过旧 | 升级到 Node ≥ 22 |
| `action-runner list` 正常，一执行 EDA 就报 no host profile | 未做通用宿主注册 | 对当前 Provider `register`，不要怀疑 Skill 文档失效 |
| `register` 报 Adapter root is incomplete | 不满足通用契约 | 使用本仓库 `adapters/easyeda-pro`（含 `package.json` 与 `scripts/bridge-control.mjs`） |
| 没装 API Gateway，或扩展未启用 / 无外部交互权限 | Provider 客户端侧缺失 | 从 `jlcext.com` 或 Pro 扩展管理装好并启用，再 `ensure` |
| `ensure` / Action 超时或连不上 | 客户端 / 网关 / Bridge | 先确认客户端、扩展与文档窗口，再查 [0.4](../references/providers/easyeda-pro/0.4-environment.md) |
| 离线设计一切正常，用户却以为 Skill 坏了 | 预期错位 | EDA 自动化是可选层，不是安装成功的标志 |
| 下单、付款、预留库存 | 需要当次明确授权 | 不把历史授权当成永久授权 |

## 智能体接入约定

供宿主智能体在首次会话使用；不替代 [阶段地图](../references/0.0-overview.md)。

1. 读取 [SKILL.md](../SKILL.md)，确认当前目标属于硬件项目工作，而不是纯软件或孤立器件问答。
2. 区分两个根目录：Skill 根目录只读引用；用户项目根目录才创建或更新 `CURRENT_HANDOFF.md` 与工程制品。
3. 用户未要求 EDA 时，不要为了「找工具」去连 EDA，也不要注册 Adapter。
4. 用户要求 EDA 时：先确认 Node → 内嵌 Adapter 是否已 `npm install` → `register` / `ensure` → 再按 `action-runner list` 找入口。连接失败只阻止该 Provider 的 EDA 写入，离线设计可继续。
5. 不要把 EasyEDA 专有步骤（Pro 安装、API Gateway、窗口选择）说成 flitrealize 安装的一部分；也不要把通用 `eda-host` 契约说成嘉立创私有协议。
6. 批量写入前验证代表对象；写入后分别报告计划、回读、保存、DRC，不用单一「成功」代替。
7. 有意义的稳定结论写回主文稿对应章节；纯查看不顺带改写无关文件。

## 和其他文档的关系

| 文档 | 用途 |
| --- | --- |
| 本文 | 第一次安装、首跑、接口分层、Adapter 契约、卡住对照 |
| [README.zh-CN.md](../README.zh-CN.md) | 产品说明、能力概览、仓库结构 |
| [SKILL.md](../SKILL.md) | 运行时执行入口与共同规则 |
| [0.0 阶段地图](../references/0.0-overview.md) | 当前阶段读哪一份参考 |
| [0.4 环境与连接](../references/providers/easyeda-pro/0.4-environment.md) | 当前 Provider（EasyEDA Pro）连接与恢复 |
| [development/action-system.md](../development/action-system.md) | Action / Provider 开发边界（维护者） |
| [adapters/easyeda-pro/README.md](../adapters/easyeda-pro/README.md) | 内嵌通道冷启动与职责边界 |
| 上游 `easyeda-api-skill` | 完整 API 资料与独立使用方式 |

首跑成功之后，按阶段读 `references/`，不必反复通读本文。
