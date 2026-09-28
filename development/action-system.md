# Action 与 Provider 开发

修改工具、发现入口或 Provider 时读取。操作说明分别放在 `references/`，连接方法见 [0.4 环境与连接](../references/providers/easyeda-pro/0.4-environment.md)。

## 四部分职责

| 部分 | 负责内容 |
| --- | --- |
| `SKILL.md` | 共同规则、阶段选择与按需加载 |
| 专项参考 | 工程意图、输入归属、操作方式与支持范围 |
| CLI／manifest | 查找能力、解析输入、衔接执行、保留结果 |
| 实现脚本 | 确定性计算、检查和 Provider 原生操作 |

Contract 保存设计意图，EDA 文件保存实际实现。plan、snapshot、输入包和 report 是派生产物；稳定结果更新到拥有该事实的制品，再同步 `CURRENT_HANDOFF.md`，不另建项目数据库。

项目参数和器件例外留在项目。通用模块不包含某块板的位号、数量、UUID 或安装路径。

## Action 与流程入口

`scripts/actions/manifest.json` 登记已实现的 Action、Workflow 和 Provider。Action 是可独立验证的操作；Workflow 说明已有操作的顺序。输入输出稳定且需要重复执行时，用薄入口衔接，不新增通用工作流语言。

- `schematic-components.mjs`：冻结放件输入，分批执行，按实际对象 ID 续接。
- `schematic-connect.mjs`：由 Contract 和现场计算短线、标识、NC 缺项，衔接重排、保存和 DRC。
- `pcb-edit.mjs`：明确移动、线宽和配色。
- `pcb-layout.mjs`：输入准备、候选求解及选定候选写入。

内部 Action 可从默认发现结果隐藏，仍保留准确名称、输入输出和测试。`list --full` 从 manifest 展开内部项，不维护第二份能力目录。

### 发现信息

已有条目可声明：

```json
{
  "keywords": ["原理图重排", "布局美化", "reflow"],
  "reference": "references/providers/easyeda-pro/2.2-schematic-workflow.md",
  "entrypoint": "scripts/schematic-reflow.mjs",
  "limitations": ["仅处理已支持的原理图对象。"]
}
```

`reference` 指向专项说明；`entrypoint` 仅填写已存在的封装脚本。`list --query` 检索名称、说明、域和关键词，不检索限制文字；Workflow 结果区分直接入口和依赖步骤。

修改发现信息后检查入口存在、用途命中、域隔离和无结果情况。查询只读本地文件，不连接 EDA 或生成项目报告。Manifest 字段由 runner 的 `loadManifest` 统一校验。

## Provider 边界

Provider 转换原生身份、引脚映射、层、坐标和网表，并承担读取、修改、保存及回读。目前只实现 EasyEDA Pro；公开登记其他软件前，要有对应实现和验证。

布局 Provider 在 `scripts/pcb-layout/pcb-layout-provider.mjs` 选择，当前实现位于 `scripts/providers/easyeda-pro/`：

- `layoutRealization(snapshot, contract, mechanical)` 产生公共布局数据，字段见下节。
- `validateContext(options)`、`target(config)` 核对该软件的连接与目标。
- `buildOperation(phase, input)` 生成执行制品，`execute(request)` 调用软件并返回结果。
- 公共执行层保留输入和回执，衔接 apply／verify／save，处理未知结果和保存恢复。

公共算法使用转换结果，原生格式由 Provider 解释。实现及其原生文件纳入发布清单和实现指纹。

当前 EasyEDA 通过 `eda-host.mjs` 调用本机 Adapter。复用该宿主时，Adapter 根目录须包含 `package.json` 和 `scripts/bridge-control.mjs`，实现相应的 status／ensure／execute／request 命令。其他 Provider 可以使用自己的执行通道，不要求模仿 EasyEDA Bridge。

### 布局数据接口

Provider 将坐标、角度和边界转换到统一约定。转换结果由 `layoutRealization` 返回；外部标准化快照也可在 `snapshot.layout` 提供相同结构。

| 字段 | 约定 |
| --- | --- |
| `schemaVersion`、`provider` | 版本为 1，软件标识与快照来源一致 |
| `units`、`coordinateSystem` | `mil`、`cartesian-y-up`，对应实际几何数值 |
| `layers` | 对象 ID 到层用途的映射；当前求解使用 `top-copper`、`all-copper`、`top-silkscreen` |
| `board` | `status: "none"` 表示没有原生板框；`"rectangle"` 提供 `bounds: {minX,minY,maxX,maxY}`；其他轮廓为 `"unsupported"` 并附原因。原生图元解析由 Provider 完成 |
| `pinMaps` | 位号 → 逻辑引脚 → 物理焊盘编号数组 |
| `labelAlignment.bottomLeft` | Provider 定义的局部底左角文字锚点编码 |
| `netlist` | 读取状态；成功时提供版本及 `components: [{ref, uniqueId?, pins: [{number, net}]}]` |
| `netNames` | 读取状态；成功时 `value` 为网名数组 |
| `target`、`provenance` | `projectId`／`documentId` 及转换依据 |

每个焊盘提供 `owner` 或 `parentComponentId`，独立焊盘明确为 null。两者同时提供时指向同一器件。位号通过所属器件 ID 关联。

原生快照同时保留以下观察，供冻结输入和回读核对使用：

| 字段 | 内容 |
| --- | --- |
| `padOwnership`、`pads[].ownershipSource` | 归属核对结果与来源 |
| `pads[].nativeGeometry` | 原始形状、孔、角度和孔偏移等；`observedPose` 标记读取时的位置，`fields` 保存各项读取状态和值 |
| `nativeNetlist`、`nativeNetNames` | API 来源与读取状态；成功时保存 `raw` 字符串或 `value` 数组 |

几何观察的状态为 `ok`、`unavailable`、`error`；成功返回的 null 保留原义。网表核对区分 `matched`、`partial`、`mismatch`、`unavailable`、`unsupported`、`error`。明确矛盾作为错误，缺失或不支持的观察保留未覆盖状态。额外空网焊盘的用途保持未定，有网络却未声明的焊盘报告不一致。

求解几何使用包围盒。形状与孔信息作为读取时的原始观察保存，移动后由新的回读取得，不作为已经变换的几何传给求解器。

## 结果与恢复

通信成功和业务成功分别判断。新增结果状态时，同步入口认可的完成状态及行为测试；被阻止、验证失败或未知写入不能报告成功。没有对象的步骤可以记录不适用。

写入前确认目标及输入仍匹配；写入后核对增量和原有内容，保存另留证据。不能实际恢复的操作不声明 rollback。保存已成功而后续验证失败时，保留已保存事实。

超时不等于未执行。保留请求句柄和未决记录，先取得原执行终态并对照现场，再继续；不重放未知写入。只恢复保存时使用同一执行链的成功 apply 回执，不重做修改。

`eda-host.mjs request` 只读查询原请求；迟到结果作为补充证据，不自动改写旧报告或释放工作流占用。执行期间仍须避免其他写入者，保存占用记录不是整张板的事务锁。

## 源码与证据

EasyEDA 源码中的 DOCHEAD 含会话字段。比较源码或生成指纹时，沿用对应 Provider 的规范化函数，避免把会话变化误判为设计变化；几何和对象事实仍参与核对。

运行输入、执行片段和分步报告保存在项目运行目录，需要恢复或追溯时保留。稳定证据不能只有临时副本；主文稿只引用来源并说明结果范围。`handoff-check` 检查引用完整性，不替代 Action 验证。

## 修改与测试

围绕实际缺陷或重复工作，修改负责该行为的模块。测试输入转换、约束效果、失败状态及恢复；Provider 改动先用隔离样例，再验证实际需要的原生操作。

审查时沿一条真实流程核对说明、入口、实现和报告是否一致，并覆盖缺项、冲突和未知结果。测试通过、现场只读和真实写入后的验证分别记录。
