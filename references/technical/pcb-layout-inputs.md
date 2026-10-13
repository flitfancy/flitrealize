# PCB 布局输入与求解参考

准备阶段的工作顺序与输入归属见 [3.3](../3.3-pcb-layout-inputs.md)。本页保存布局字段、求解命令、后端限制和运行示例。准备数据或选择后端时读取相应小节；实际原生读取、移动与写回见 [3.5 布局与空间](../providers/easyeda-pro/3.5-pcb-placement.md)。

粗布局意图先按[五条粗布局原则](../3.5.1-block-layout.md#粗布局原则)整理；量化方向与当前支持见[衔接说明](../3.5.1-block-layout.md#量化与现有脚本的衔接)。本页只维护已有输入字段和真实入口，不因新增原则或阶段交接就增加未实现的配置键。

## 粗布局软评分

项目配置可选`roughLayoutPolicy`，目前只参与CP-SAT语义粗布局。其他布局后端不支持此配置；默认未启用，原有硬板框、固定件、装配间距及电气条件保持。

```json
{
  "roughLayoutPolicy": {
    "schemaVersion": 1,
    "groupCompactnessWeight": 0.2,
    "density": {
      "weight": 0.25,
      "cellMil": 500,
      "targetCount": 4,
      "offsetFractions": [0, 0.5]
    },
    "connectionSide": {
      "weight": 0.25,
      "minimumConnectedPads": 8,
      "excludeNets": ["GND"],
      "depthLevels": [
        {"minimumSidePads": 3, "depthMil": 40},
        {"minimumSidePads": 6, "depthMil": 80},
        {"minimumSidePads": 12, "depthMil": 120}
      ],
      "exemptRelationKinds": ["bypass", "bootstrap", "power-path"]
    }
  }
}
```

这是粗布局参数示例，数值是项目的搜索偏好，不是制造要求。

- `groupCompactnessWeight`缩放功能组收拢目标与对应候选分数；0.2表示原强度的五分之一。
- `density`在错位粗网格内统计器件中心，超过软目标的数量参与平方惩罚。物理包络面积超过一个窗口的大件不参与中心计数，真实占位仍保留。边界窗口按面积折算软目标，错位网格减少器件挤在格点附近的偏差。这是器件分布代理，不是占用面积或可走线容量。
- `connectionSide`按真实焊盘及网络外部端点判定有效连接，排除未接网络及声明的排除网，再按最近的封装边分侧。连接达到项目等级的侧边产生软留白带，随许可旋转变化；其他器件进入该带会计分。它不逐脚生成出口，也不禁止关键局部器件靠近。
- 局部豁免来自Contract中指定种类的关系；项目可额外给`exemptRefsByOwner: {"<主器件位号>": ["<关联器件位号>"]}`。声明豁免不能替代硬约束或电气验证。

候选保留`roughLayoutMetrics`、`roughLayoutScore`及未缩放的`semanticCompactnessUnscaledScore`；排序使用原比较分、缩放后的功能组分和粗布局附加分。求解后独立重算同一量化口径，仍需沿原公共几何验收。实际走线、参考地、阻抗和丝印不在这两项评分的验收范围内。

## 输入从哪里来

| 来源 | 提供的内容 | 谁来维护 |
| --- | --- | --- |
| Schematic Contract | 器件身份、逻辑引脚、网络、功能块、电气意图 | 复用上游设计 |
| 当前 PCB | 对象 ID、归属、位置、角度、层、锁定、焊盘与位号几何 | Provider 读取 |
| 项目布局配置 | 固定条件、接口方向、装配间距、操作空间和关联要求 | 按工程依据填写 |
| 搜索配置 | 起点、种子、预算、权重、候选数量 | 按本次目标调整 |

AI 补充工程意图和缺项；脚本读取已有数据、转换单位、关联对象并计算几何。当前坐标和网表不需要手工再抄一份。

### 基础规则与本轮变化

共用 `prepare` 读取 Contract、项目配置和完整 PCB，冻结成员、真实端点、锁、板框、外部对象及规则。粗布局安排块的区域与通道；细布局复用这份输入，在本轮许可范围内安排簇和器件。

细布局给出 `blockId` 并省略 `movableRefs` 时，从既有块成员中扣除真实锁、锁定焊盘和本轮 `fixedRefs`；显式成员列表仍覆盖默认选择。允许让位的其他块须在 `allowedNeighborBlockIds` 中明确列出，只展开成员，不生成刚性块变换。区域和预留用途仍需声明，范围外对象继续保留；主芯片不因名称或仅禁止旋转而默认固定。派生来源与排除原因保存在 `scope.selection`。

基础电气关系仅来自已编译的 `extensions.pcbLayout.relations`，以其稳定 `id` 引用，无需再抄端点。准备回执记录该 ID 到实际编译目标的绑定。本轮关系的合成分三种：

细布局可明确启用 `relationSelection: "scope"`，按实际可动成员派生相关基础关系，固定的外部端点仍保留。此时只填写本轮替换／追加例外；显式引用覆盖同一 ID 的派生项，不增加第二份目标。默认仍为 `explicit`，旧请求不会因为升级而自动增加审阅关系或改变计分。

| 合成方式 | 有效目标 |
| --- | --- |
| `inherit`（引用时默认） | 保留对应基础软目标及其实际归一化权重，不增加第二条目标 |
| `replace-objective` | 用显式本轮权重和物理目标替换引用的那一条软目标 |
| `append-objective` | 保留基础目标，明确追加本轮目标；也可直接声明新端点 |

替换软目标不删除基础硬上限，新增硬条件与基础条件共同生效。未知、重复引用或端点冲突直接报告。未引用的旧请求继续按原规则追加，不静默去重；相同端点可以服务不同的明确物理目标。引用要求保留基础目标，不能同时使用 `objective.retainSource: false`。

逻辑引脚映射到多个物理焊盘时，引用保留全部焊盘及其网络，不任意挑选一个。编译和独立审计沿用基础模型的最小焊盘对距离代理；报告另列全部焊盘对距离和最大值。这个距离条件不表示所有焊盘已连通，不能用最近一对通过代替全端点连接检查。完整网表与走线交接仍包含所有映射焊盘，实际连接由对应网络验证与走线检查确认。

`problem.objectiveComposition` 和候选审计列出引用来源、继承／替换／追加、原目标与有效目标的权重及物理口径。基础权重经过公共归一化，本轮权重直接参与声明的距离目标，两者不能只比较填写的数字。具体请求字段与示例见[细布局执行接口](pcb-fine-layout-execution.md#输入与权限)。文字要求仍留在覆盖诊断中，不按文字推断距离、回地端或权重。

## 项目需要提供什么

### 器件

| 内容 | 输入位置 |
| --- | --- |
| 是否进入 PCB、逻辑引脚及网络 | Contract 的 `components[].includeInPcb`、`pins` 和 `nets` |
| 固定位置、允许的旋转 | `hard.fixed`、`hard.preserveRotations`、`componentFeatures[].allowedRotationDeltas` |
| 接口贴边、长边方向、操作面朝外 | `componentFeatures[].edge` |
| 装配余量或已确认的 courtyard | `assemblyRules`，按封装名称复用；器件例外放 `overrides` |
| 位号相对位置模板 | 机械配置的 `labelTemplates` |
| 插拔、操作等额外空间 | `geometryViews.envelopes` |
| 去耦、采样、功率连接等关系 | Contract 的 `extensions.pcbLayout.relations` |

固定坐标来自当前回读。贴边用 `edge: true` 可自动选四边；需要限定时填写 `sides`、`alignment` 或 `outwardAtRotation0`。`alignment` 可选 `long-side`／`short-side`；方向编码为 `left=minX`、`right=maxX`、`top=minY`、`bottom=maxY`。

`labelTemplates` 可设置 `default`、按封装名匹配的 `footprints` 和按位号指定的 `overrides`。模板参考边界 `anchor` 默认是 `body-and-pads`，也可选 `pads`；`minGapMil` 调整位号与参考边界的距离。

### 功能块与块间关系

| 内容 | 输入位置 |
| --- | --- |
| 块名、用途、成员 | Contract 的 `blocks` |
| 器件到本块锚点中心的距离上限 | `componentFeatures[].block`：`anchors` 加 `maxDistanceMil` 或 `maxDistanceByGeometry` |
| 一起参与移动／旋转的局部组 | `spatial.localGroups` |
| 块间明确的连接端点和距离上限 | `blockCoupling.relations` |
| 其他几何距离上下限 | `spatial.relations[].band.hardMinMil/hardMaxMil` |

功能块归属本身不产生距离限制。锚点中心是所选器件原点的平均位置，距离按曼哈顿距离计算。局部组可以协同移动，组内器件仍可单独调整。跨块网络由 Contract 计算；需要限定的关系另行声明端点、网络及距离。

### 整板

| 内容 | 输入位置 |
| --- | --- |
| 全局固定条件、引脚距离上限 | `hard.fixed`、`hard.pinDistanceLimits` |
| 固定矩形板框 | 原生板框自动读取；也可填写 `hard.boardBounds: {minX, minY, maxX, maxY}`，单位 mil |
| 器件与位号联合占位的最小间距 | 机械配置的 `clearanceMil` |
| 物理装配间距与明确的成对要求 | `assemblyRules`、`spacingPolicy` |
| 禁布区域及涉及的几何对象 | `spatial.zones`，`mode: "keepout"` |
| 纳入连接跨度评价的网络与测试点 | `connectivity` |
| 指标权重 | `comparisonWeights` |
| 搜索后端的预算与起点 | `search`、`initialization` |

已有原生矩形板框时自动作为固定边界；同时配置边界时必须与现场一致。`hard.boardBounds: null` 表示不额外指定边界，两处均无板框时使用无板框布局。机械配置中的 `boardBounds` 参与同一一致性检查。支持的原生轮廓见 [3.5](../providers/easyeda-pro/3.5-pcb-placement.md#输入准备与候选求解)。

有固定板框时，器件和焊盘占位、独立测试点及位号须位于板内，贴边相对于真实板边；装配余量用于器件间距，不自动成为板边退距。不支持器件越板悬伸。区域的 `preferEmpty`／`preferFilled` 和局部组紧凑度目前作为观察指标，不参与总分。

## 电气关系怎样填写

将有明确用途的关系写入 `Contract.extensions.pcbLayout`，引用已有位号、逻辑引脚和网络：

```json
{
  "schemaVersion": 1,
  "relations": [
    {
      "id": "supply-bypass",
      "kind": "bypass",
      "from": {"ref": "C_BYP", "pin": "1"},
      "to": {"ref": "U_LOAD", "pin": "VDD"},
      "net": "VDD",
      "basis": "已确认的电源旁路关系及其依据"
    }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| `id`、`kind` | 唯一关系 ID；类型为 `bypass`、`bootstrap`、`sense` 或 `power-path` |
| `from`、`to`、`net` | 器件逻辑引脚端点及其公共网络 |
| `basis` | 关系的工程依据 |
| `requirementId` | 可选，关联 Contract 中的 `constraints.id` |
| `maxDistanceMil` | 可选，有依据的引脚距离硬上限 |

`bypass`／`bootstrap` 形成去耦连接目标，`sense` 形成采样目标，`power-path` 形成功率连接目标；距离上限单独作为硬条件。端点距离按焊盘位置的曼哈顿距离（|dx| + |dy|）计算，单位 mil。该扩展的端点目前只支持器件引脚。用途文字不会自动生成距离数值，未能编译的要求仍保留在 Contract 和覆盖诊断中。字段定义见 [关系 schema](../../schemas/pcb-layout-intent.v1.schema.json)。

## 间距和搜索设置

装配规则按封装提供 `marginMm`，或提供已确认的局部 `courtyard`。脚本结合封装和焊盘几何计算装配边界；使用装配规则时，每个器件的封装都应有对应规则。

物理间距配置使用 `schemaVersion: 2`、`mode: "active"`、`source: "assembly-courtyard"` 和 `geometry: "physical"`。其中 `bandRatios` 的 `rejectBelow`、`neutralMin`、`neutralMax` 需要填写。例如 `0.75 / 0.9 / 1.2` 表示基准的 75% 为拒绝界限，90%～120% 为不扣分区间；这是配置示例。

脚本从装配余量、绝对最小间距及成对要求计算物理硬下限 H，再令比例基准 B = H / rejectBelow。位号防撞单独检查。

评分由几何尺度归一化的连接距离与间距均匀度组成。可用权重是 `power`、`sense`、`bypass`、`connectivity`、`uniformity`；至少一个连接指标的权重大于 0。权重为 0 的指标不计入总分。

`search` 的搜索步长、迭代数、移动概率和偏好组由搜索后端校验；执行该后端时，`search.profiles` 至少包含一组 `name`、`seed`，可用 `weightMultipliers` 调整该组权重。公共输入准备、语义转换和 CP-SAT 不要求这些未使用的搜索参数，可省略 `search`。旧配置中的 `search.rotationDeltas` 仍是公共旋转约束，继续生效；新配置可按器件在 `hard.allowedRotationDeltasByRef` 声明。`initialization` 可选择 `existing`、`fresh` 或 `mixed`，并设置起点数量、种子与探索幅度。默认沿用现有布局、生成一个起点。

尺寸按字段单位填写：`*Mil` 使用 mil，装配余量 `marginMm` 使用 mm，角度使用度。

## 配置放在哪里

主配置默认是项目内的 `design/PCB_LAYOUT_CONSTRAINTS.v1.json`，也可用 `--config` 指定。它通过 `contractFile` 和 `mechanicalRulesFile` 引用 Contract 与机械配置，并提供 `hard`、`groups`、`connectivity`、`comparisonWeights`；搜索后端另需 `search`。机械配置需提供 `clearanceMil`；软件目标身份由现场读取并核对。

附加配置可以内嵌，也可以引用文件：

| 内嵌字段 | 文件引用 |
| --- | --- |
| `componentFeatures` | `featuresFile`；文件为 `{schemaVersion: 1, components: [...]}` |
| `spatial`、`geometryViews` | `spatialFile`、`geometryViewsFile` |
| `blockCoupling` | `blockCouplingFile` |
| `assemblyRules`、`spacingPolicy` | `assemblyRulesFile`、`spacingPolicyFile` |
| `initialization` | `initializationFile` |
| `comparisonWeights` | `weightsFile`；文件中的 `weights` 对象 |

引用路径相对于项目根目录；提供文件引用时，该文件内容作为对应项的有效值。可从[完整离线示例](../../assets/pcb-layout/minimal-project/design/PCB_LAYOUT_CONSTRAINTS.v1.json)查看字段组合，示例数值仅用于演示格式。

## 脚本自动取得和检查什么

Provider 读取位置、旋转、层、锁定、封装、焊盘与位号几何、对象归属和原生网表，转换为统一坐标与层用途。开发字段见 [Provider 数据接口](../../development/action-system.md#布局数据接口)。

脚本关联 Contract 与实际对象，核对引脚网络、编译规则，并计算物理边界、邻接关系和评分尺度。`constraints` 的文字要求进入覆盖清单，自动编译使用 `extensions.pcbLayout` 的明确关系；要求原有的 `evidenceState` 与本次布局覆盖、几何检查分别记录。

| 情况 | 处理 |
| --- | --- |
| 纳入 PCB 的器件缺失，或存在未声明对象 | 报告身份不一致 |
| `includeInPcb: false` | 从布局输入副本排除；若仍存在于 PCB，则报告冲突 |
| 归属、网络、固定条件或规则互相矛盾 | 返回具体错误，停止求解 |
| 缺少已声明规则所需的几何或参数 | 返回缺项，不补猜测值 |
| 未提供可选规则 | 不产生对应约束 |
| 可选原生观察不可用 | 保留未覆盖状态，继续检查其他可用数据 |
| 当前位置违反可修复的间距或贴边条件 | 作为布局问题报告，与输入错误分开 |

`prepare` 返回输入可用性、工程要求覆盖和当前布局几何结果。`summary.json` 提供摘要，`layout-input.json` 提供输入回执，`diagnostics.json` 列出具体问题，`inputs.json` 冻结本次输入。网名与距离检查不代表铜连接、电气或热设计已经通过。

## 布局求解入口与后端

下面的命令与模式按实际支持范围使用。数值运行依赖按需见[首跑指南](../../docs/first-run.md#数值与路由环境)。

CP-SAT语义求解可用项目配置的`roughLayoutPolicy`减弱功能组收拢，并启用上述两项软评分，字段见[粗布局软评分](pcb-layout-inputs.md#粗布局软评分)。疏密使用错位粗网格中的器件中心计数，大件保留真实硬占位；连接侧由有外部端点的非排除网络焊盘派生，已声明去耦、功率等局部器件可豁免占位惩罚。两项真正进入求解目标，候选也独立重算同一口径；它们不新增统一硬间距，也不证明实际铜能布通。未声明该配置时保持原行为。

粗布局只需器件占位时，可用共享 `scopeLayoutModel()` 保留板框并声明 `includeLabels:false`，再让语义求解的 `compileSemanticCpSatProblem()` / `runCpsatLayout()` 使用同一选项；新指定位置通过 `contextPlacements` 进入范围模型，已有原生锁仍保留。此类候选注明位号未纳入求解，不能直接作为完整原生写入计划；写回前补齐并验收完整器件、位号和焊盘计划。

```text
node <skill>/scripts/pcb-layout.mjs --project-root <项目> --mode semantic --prepared <prepare目录>
node <skill>/scripts/pcb-layout.mjs --project-root <项目> --mode solve --backend cpsat --prepared <prepare目录> --candidates 3 --seconds 30 --python <解释器>
node <skill>/scripts/pcb-block-layout.mjs --project-root <项目> --input <请求JSON> --mode open|pack|verify|channels --python <解释器>
```

CP-SAT 与原搜索后端共用 `prepareLayoutInputs`、位号模板、`validatePlan` 和报告。选定完整候选沿用 `pcb-layout.mjs --mode apply`，现场和实现指纹变化后重新准备。块内/带铜块结果不是完整原生写入计划，不直接套用 apply。

实现指纹从布局入口追踪相对导入、求解 Worker/Python、准备与验收代码、原生阶段片段及宿主通道依赖。独立布线实现和纯 HTML 展示模块不使布局候选失效；布局复用的铜几何仍参与指纹。外部注册适配器、EDA 可执行文件和已安装 Python 环境不属于随包实现指纹，现场身份、基线和运行结果仍按原执行流程核对。

独立布局入口可调用 `layoutEngineIdentity({entrypoints:[skill根内的相对入口]})`，在公共依赖上增加自己的导入闭包；测试可另传 `skillRoot`。新非字面动态资源必须在 `pcb-layout-engine.mjs` 声明并补失效对照测试，不能靠目录扫描猜测。


### 最小运行示例

随包 [两器件样例项目](../../assets/pcb-layout/minimal-project/design/PCB_LAYOUT_CONSTRAINTS.v1.json) 和 [open 请求](../../assets/pcb-layout/block-open-request.json) 可用于首次试运行。先将 `assets/pcb-layout/minimal-project/` 复制到独立 `<EXAMPLE_PROJECT>`；真实项目继续使用自己的输入，不写回样例。

```text
node "<skill>/scripts/pcb-layout.mjs" --project-root "<EXAMPLE_PROJECT>" --mode prepare --snapshot "<EXAMPLE_PROJECT>/snapshot.json"
node "<skill>/scripts/pcb-block-layout.mjs" --project-root "<EXAMPLE_PROJECT>" --input "<skill>/assets/pcb-layout/block-open-request.json" --prepared "<上一条返回的report目录>" --mode open --output evidence/open-example --python "<数值环境的python>"
```

prepare 返回报告目录；它没有 `--output` 参数。block 的 `--prepared` 接受该目录或其中 `inputs.json`，与请求内嵌 `bundle` 二选一，无需复制大JSON。样例为离线教学数据，不能作为实际PCB的apply来源。

| 小请求字段 | 来源/用途 |
| --- | --- |
| `spec.refs/gaugeRef` | 冻结输入中的本次成员与局部坐标锚点 |
| `criticalPairs[].left/right` | `{ref,id}`，ID取输入包的实际物理焊盘；可给同网 `net/weight` |
| `settings` | 本次预算与数值求解设置，如 `timeLimitSeconds/workers` |
| `options` | 候选数、尝试数等执行预算 |

样例的完整JSON给出可复制的字段结构。改用于本项目时只替换明确范围、焊盘ID和工程意图；不重抄器件坐标或上游规则，数值不是制造默认。

### 语义与冷启动

`pcb-layout-semantic.mjs` 从已声明的局部关系、分组、网络和功能块派生柔性子组，保存关系来源与未归属项。角色文字推断默认关闭；如项目要使用，以 `--semantic-policy <项目JSON>` 明确 `roles`、关联权重及停用词，不将某项目器件名写入模块。

冷启动不读取旧位置提示，也不施加旧布局移动偏好；数学坐标原点仅消除平移/旋转重复。先生成内部可行检查点，再搜索多个候选。内部检查点、搜索参数、失败与精确验收分别存证。`OPTIMAL` 只描述量化电气/紧凑度代理模型；不代表实际走线、地回流或制造最优。

### 开放功能块

open 请求为 `{bundle,spec,settings,options}`。`bundle` 是既有 `inputs.json`；`spec` 明确 `refs/gaugeRef`、上下文和允许变化范围。默认保留选中的原生锁及固定件；只用 `releaseFixedRefs` 显式释放普通 `hard.fixed`，原生锁、显式机械锁及来源未知的旧锁不释放。同一器件具有多个锁来源时逐项保留。context/gauge 与保留固定位姿不一致时拒绝。独立块求解可释放板框/边缘锚点，不人为给局部形态附加毫米距离上限；保留实际器件几何、块内电气关系及显式机械约束。数值搜索域是计算边界，应在报告中说明，不能当作新的板框。

开放输入由共享 `scopeLayoutModel()` 保留范围、身份和锁来源，再以 `placementMode: 'open'` 明确编译。板框字段保持空，`computationalCoordinateMil` 仅描述计算搜索域；不把它变成机械板框。

通过的局部候选再生成刚性模板；必须核对模板所有器件唯一归属及外部端口，局部多端点连接不等于跨块完整网络完成。

### 带铜模板装入与冲突反馈

新请求为 `{bundle,groups,copperRules,refs?,settings,options}`；verify 另给 `transforms`，channels 另给 `channelPolicy`。`bundle` 复用准备层的 `inputs.json`，也可由 `--prepared` 指定，不重新填写板框与布局规则。

- `groups` 是已验证局部候选的刚性模板，可由 `createRigidBlock()` 生成；保留 `id/parts/pads/copper/rotations/base/fixed/keepouts/fanouts`、器件唯一归属及局部铜验证状态。
- `refs` 省略时覆盖公共 model 的全部器件；局部范围须明确给出，模板成员与所选范围完全一致。
- `copperRules:{copperGapMil,copperEdgeMil,source}` 来自上游布线/制造规则并记录依据。布局 model 不拥有铜净空与铜到板边规则，不在此推断这些值；全部几何单位为 mil。

`createRigidBlockAtlas(model,groups,{refs,copperRules,...})` 返回 `{atlas,model}`。它从共享 scope 派生实际板框、固定姿态、许可旋转、装配间距、贴边和显式分离规则；网络权重与排除网默认沿用公共 model。模板作为后端表示，不维护第二套布局规则。焊盘及焊盘铜由公共model按组内位姿重派生；声明的ID、归属、网络或几何矛盾时拒绝，派生后遗漏也不能通过公共验收。

由公共 model 派生的 atlas 标记 `publicValidationRequired:true`。pack/verify 必须绑定对应公共 model，再由 `validateRigidBlockPublicModel()` 重建候选并调用原 `validatePlan()`；装配/操作空间、引脚距离、块锚点和空间约束以该验收为准。保存后的派生 atlas 再验证时，同时提供对应 `bundle`，不能只凭 atlas 的几何结果宣称公共规则通过。位号仍明确在本研究范围之外。

旧的独立 `{atlas,settings,options}` 保留为 legacy 离线几何诊断，verify 可另给 transforms；报告保留 `LEGACY_EXPLICIT_RIGID_ATLAS`，不会把调用者手填规则或原生层号当作已派生、已验证的公共布局合同。

CP-SAT 装入后独立检查几何、异网铜、显式禁布与引出空间，把精确冲突变成 `cuts` 回求；最终公共验收失败仍拒绝候选。`channels` 用输入铜通道做 FFT 快筛，输出只供搜索剪枝，之后继续绑定公共 model 精确验证。保留局部模板的地/载流/制造未验证状态，完整原生写入仍沿原执行流程另行生成并验收。

### 范围

当前迁入的是正交几何和刚性模板；它不实现全局协商拥塞、LNS/RUDY或任意柔性形变。模板支持覆盖范围由传入数据和验收报告决定，完整位号、独立测试焊盘、机械操作空间及原生 DRC 仍由现有完整执行流程检查。未知几何不静默降成无约束。
