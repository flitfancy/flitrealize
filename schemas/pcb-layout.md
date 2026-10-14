# PCB 布局数据约定

本页集中现有项目配置、标准化读取、本轮请求及候选制品语义。[电气关系机器定义](pcb-layout-intent.v1.schema.json)保持原版本。准备流程见 [3.3](../docs/3.3-pcb-layout-inputs.md)，求解命令见[技术参考](../docs/technical/pcb-layout-inputs.md)，应用与恢复见[块内布局接口](../docs/technical/pcb-fine-layout-execution.md)。

## 布局标准化与原生观察

软件适配层将坐标、角度和边界转换到统一约定。转换结果由 `layoutRealization` 返回；外部标准化快照也可在 `snapshot.layout` 提供相同结构。

| 字段 | 约定 |
| --- | --- |
| `schemaVersion`、`provider` | 版本为 1，软件标识与快照来源一致 |
| `units`、`coordinateSystem` | `mil`、`cartesian-y-up`，对应实际几何数值 |
| `layers` | 对象 ID 到软件适配层已归一层用途的映射，如 `top-copper`、`all-copper`、`top-silkscreen`；后端不猜原生数值层号 |
| `board` | `status: "none"` 表示没有原生板框；`"rectangle"` 提供 `bounds: {minX,minY,maxX,maxY}`；其他轮廓为 `"unsupported"` 并附原因。原生图元解析由软件适配层完成 |
| `pinMaps` | 位号 → 逻辑引脚 → 物理焊盘编号数组 |
| `labelAlignment.bottomLeft` | 软件适配层定义的局部底左角文字锚点编码 |
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

公共布局使用由原生观察派生的包围盒/装配视图；实际铜接触使用走线模型的导电形状，分别记录近似范围。形状与孔的原始观察对应读取时位姿，移动后由新回读取得，不冒充已经变换的事实。

## 基础规则与本轮变化

共用 `prepare` 读取电路设计稿、项目配置和完整 PCB，冻结成员、真实端点、锁、板框、外部对象及规则。功能块布局安排块的区域与通道；块内布局复用这份输入，在本轮许可范围内安排簇和器件。

块内布局给出 `blockId` 并省略 `movableRefs` 时，从既有块成员中扣除真实锁、锁定焊盘和本轮 `fixedRefs`；显式成员列表仍覆盖默认选择。允许让位的其他块须在 `allowedNeighborBlockIds` 中明确列出，只展开成员，不生成刚性块变换。区域和预留用途仍需声明，范围外对象继续保留；主芯片不因名称或仅禁止旋转而默认固定。派生来源与排除原因保存在 `scope.selection`。

基础电气关系仅来自已编译的 `extensions.pcbLayout.relations`，以其稳定 `id` 引用，无需再抄端点。准备回执记录该 ID 到实际编译目标的绑定。本轮关系的合成分三种：

块内布局可明确启用 `relationSelection: "scope"`，按实际可动成员派生相关基础关系，固定的外部端点仍保留。此时只填写本轮替换／追加例外；显式引用覆盖同一 ID 的派生项，不增加第二份目标。默认仍为 `explicit`，旧请求不会因为升级而自动增加审阅关系或改变计分。

| 合成方式 | 有效目标 |
| --- | --- |
| `inherit`（引用时默认） | 保留对应基础软目标及其实际归一化权重，不增加第二条目标 |
| `replace-objective` | 用显式本轮权重和物理目标替换引用的那一条软目标 |
| `append-objective` | 保留基础目标，明确追加本轮目标；也可直接声明新端点 |

替换软目标不删除基础硬上限，新增硬条件与基础条件共同生效。未知、重复引用或端点冲突直接报告。未引用的旧请求继续按原规则追加，不静默去重；相同端点可以服务不同的明确物理目标。引用要求保留基础目标，不能同时使用 `objective.retainSource: false`。

逻辑引脚映射到多个物理焊盘时，引用保留全部焊盘及其网络，不任意挑选一个。编译和独立审计沿用基础模型的最小焊盘对距离代理；报告另列全部焊盘对距离和最大值。这个距离条件不表示所有焊盘已连通，不能用最近一对通过代替全端点连接检查。完整网表与走线交接仍包含所有映射焊盘，实际连接由对应网络验证与走线检查确认。

`problem.objectiveComposition` 和候选审计列出引用来源、继承／替换／追加、原目标与有效目标的权重及物理口径。基础权重经过公共归一化，本轮权重直接参与声明的距离目标，两者不能只比较填写的数字。具体请求字段与示例见[块内布局执行接口](pcb-layout.md#块内布局输入与权限)。文字要求仍留在覆盖诊断中，不按文字推断距离、回地端或权重。

## 项目布局配置

### 器件

| 内容 | 输入位置 |
| --- | --- |
| 是否进入 PCB、逻辑引脚及网络 | 电路设计稿的 `components[].includeInPcb`、`pins` 和 `nets` |
| 固定位置、允许的旋转 | `hard.fixed`、`hard.preserveRotations`、`componentFeatures[].allowedRotationDeltas` |
| 接口贴边、长边方向、操作面朝外 | `componentFeatures[].edge` |
| 装配余量或已确认的装配边界 | `assemblyRules`，按封装名称复用；器件例外放 `overrides` |
| 位号相对位置模板 | 机械配置的 `labelTemplates` |
| 插拔、操作等额外空间 | `geometryViews.envelopes` |
| 去耦、采样、功率连接等关系 | 电路设计稿的 `extensions.pcbLayout.relations` |

固定坐标来自当前回读。贴边用 `edge: true` 可自动选四边；需要限定时填写 `sides`、`alignment` 或 `outwardAtRotation0`。`alignment` 可选 `long-side`／`short-side`；方向编码为 `left=minX`、`right=maxX`、`top=minY`、`bottom=maxY`。

`labelTemplates` 可设置 `default`、按封装名匹配的 `footprints` 和按位号指定的 `overrides`。模板参考边界 `anchor` 默认是 `body-and-pads`，也可选 `pads`；`minGapMil` 调整位号与参考边界的距离。

### 功能块与块间关系

| 内容 | 输入位置 |
| --- | --- |
| 块名、用途、成员 | 电路设计稿的 `blocks` |
| 器件到本块锚点中心的距离上限 | `componentFeatures[].block`：`anchors` 加 `maxDistanceMil` 或 `maxDistanceByGeometry` |
| 一起参与移动／旋转的局部组 | `spatial.localGroups` |
| 块间明确的连接端点和距离上限 | `blockCoupling.relations` |
| 其他几何距离上下限 | `spatial.relations[].band.hardMinMil/hardMaxMil` |

功能块归属本身不产生距离限制。锚点中心是所选器件原点的平均位置，距离按曼哈顿距离计算。局部组可以协同移动，组内器件仍可单独调整。跨块网络由电路设计稿计算；需要限定的关系另行声明端点、网络及距离。

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

已有原生矩形板框时自动作为固定边界；同时配置边界时必须与现场一致。`hard.boardBounds: null` 表示不额外指定边界，两处均无板框时使用无板框布局。机械配置中的 `boardBounds` 参与同一一致性检查。支持的原生轮廓见 [3.5](../docs/providers/easyeda-pro/3.5-pcb-placement.md#输入准备与候选求解)。

有固定板框时，器件和焊盘占位、独立测试点及位号须位于板内，贴边相对于真实板边；装配余量用于器件间距，不自动成为板边退距。不支持器件越板悬伸。区域的 `preferEmpty`／`preferFilled` 和局部组紧凑度目前作为观察指标，不参与总分。

### 电气关系

将有明确用途的关系写入电路设计稿的 `extensions.pcbLayout`，引用已有位号、逻辑引脚和网络：

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
| `requirementId` | 可选，关联电路设计稿中的 `constraints.id` |
| `maxDistanceMil` | 可选，有依据的引脚距离硬上限 |

`bypass`／`bootstrap` 形成去耦连接目标，`sense` 形成采样目标，`power-path` 形成功率连接目标；距离上限单独作为硬条件。端点距离按焊盘位置的曼哈顿距离（|dx| + |dy|）计算，单位 mil。该扩展的端点目前只支持器件引脚。用途文字不会自动生成距离数值，未能编译的要求仍保留在电路设计稿和覆盖诊断中。字段定义见 [关系 schema](pcb-layout-intent.v1.schema.json)。

### 间距和搜索设置

装配规则按封装提供 `marginMm`，或提供已确认的局部 `courtyard`。脚本结合封装和焊盘几何计算装配边界；使用装配规则时，每个器件的封装都应有对应规则。

物理间距配置使用 `schemaVersion: 2`、`mode: "active"`、`source: "assembly-courtyard"` 和 `geometry: "physical"`。其中 `bandRatios` 的 `rejectBelow`、`neutralMin`、`neutralMax` 需要填写。例如 `0.75 / 0.9 / 1.2` 表示基准的 75% 为拒绝界限，90%～120% 为不扣分区间；这是配置示例。

脚本从装配余量、绝对最小间距及成对要求计算物理硬下限 H，再令比例基准 B = H / rejectBelow。位号防撞单独检查。

评分由几何尺度归一化的连接距离与间距均匀度组成。可用权重是 `power`、`sense`、`bypass`、`connectivity`、`uniformity`；至少一个连接指标的权重大于 0。权重为 0 的指标不计入总分。

`search` 的搜索步长、迭代数、移动概率和偏好组由搜索后端校验；执行该后端时，`search.profiles` 至少包含一组 `name`、`seed`，可用 `weightMultipliers` 调整该组权重。公共输入准备、语义转换和 CP-SAT 不要求这些未使用的搜索参数，可省略 `search`。旧配置中的 `search.rotationDeltas` 仍是公共旋转约束，继续生效；新配置可按器件在 `hard.allowedRotationDeltasByRef` 声明。`initialization` 可选择 `existing`、`fresh` 或 `mixed`，并设置起点数量、种子与探索幅度。默认沿用现有布局、生成一个起点。

尺寸按字段单位填写：`*Mil` 使用 mil，装配余量 `marginMm` 使用 mm，角度使用度。

### 配置放在哪里

主配置默认是项目内的 `design/PCB_LAYOUT_CONSTRAINTS.v1.json`，也可用 `--config` 指定。它通过 `contractFile` 和 `mechanicalRulesFile` 引用电路设计稿与机械配置，并提供 `hard`、`groups`、`connectivity`、`comparisonWeights`；搜索后端另需 `search`。机械配置需提供 `clearanceMil`；软件目标身份由现场读取并核对。

附加配置可以内嵌，也可以引用文件：

| 内嵌字段 | 文件引用 |
| --- | --- |
| `componentFeatures` | `featuresFile`；文件为 `{schemaVersion: 1, components: [...]}` |
| `spatial`、`geometryViews` | `spatialFile`、`geometryViewsFile` |
| `blockCoupling` | `blockCouplingFile` |
| `assemblyRules`、`spacingPolicy` | `assemblyRulesFile`、`spacingPolicyFile` |
| `initialization` | `initializationFile` |
| `comparisonWeights` | `weightsFile`；文件中的 `weights` 对象 |

引用路径相对于项目根目录；提供文件引用时，该文件内容作为对应项的有效值。可从[完整离线示例](../assets/pcb-layout/minimal-project/design/PCB_LAYOUT_CONSTRAINTS.v1.json)查看字段组合，示例数值仅用于演示格式。

## 功能块布局软评分

项目配置可选`roughLayoutPolicy`，目前只参与CP-SAT语义功能块布局。其他布局后端不支持此配置；默认未启用，原有硬板框、固定件、装配间距及电气条件保持。

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

这是功能块布局参数示例，数值是项目的搜索偏好，不是制造要求。

- `groupCompactnessWeight`缩放功能组收拢目标与对应候选分数；0.2表示原强度的五分之一。
- `density`在错位粗网格内统计器件中心，超过软目标的数量参与平方惩罚。物理包络面积超过一个窗口的大件不参与中心计数，真实占位仍保留。边界窗口按面积折算软目标，错位网格减少器件挤在格点附近的偏差。这是器件分布代理，不是占用面积或可走线容量。
- `connectionSide`按真实焊盘及网络外部端点判定有效连接，排除未接网络及声明的排除网，再按最近的封装边分侧。连接达到项目等级的侧边产生软留白带，随许可旋转变化；其他器件进入该带会计分。它不逐脚生成出口，也不禁止关键局部器件靠近。
- 局部豁免来自电路设计稿中指定种类的关系；项目可额外给`exemptRefsByOwner: {"<主器件位号>": ["<关联器件位号>"]}`。声明豁免不能替代硬约束或电气验证。

候选保留`roughLayoutMetrics`、`roughLayoutScore`及未缩放的`semanticCompactnessUnscaledScore`；排序使用原比较分、缩放后的功能组分和功能块布局附加分。求解后独立重算同一量化口径，仍需沿原公共几何验收。实际走线、参考地、阻抗和丝印不在这两项评分的验收范围内。

## 开放块请求字段

| 小请求字段 | 来源/用途 |
| --- | --- |
| `spec.refs/gaugeRef` | 冻结输入中的本次成员与局部坐标锚点 |
| `criticalPairs[].left/right` | `{ref,id}`，ID取输入包的实际物理焊盘；可给同网 `net/weight` |
| `settings` | 本次预算与数值求解设置，如 `timeLimitSeconds/workers` |
| `options` | 候选数、尝试数等执行预算 |

样例的完整JSON给出可复制的字段结构。改用于本项目时只替换明确范围、焊盘ID和工程意图；不重抄器件坐标或上游规则，数值不是制造默认。

## 语义分组策略

当功能块布局须保留已声明功能块的分组边界时，在本轮语义策略明确 `groupScope: "declared-block"`。每个实际器件须有唯一块归属；跨块关系保留实际端点距离目标，以 `boundaryLinks` 报告，但不用于合并物理组。块内仍为柔性分组，没有增加区域、固定姿态或距离硬上限。未声明时保持原 `relations` 分组方式；启用前核对分组输出与电气关系均保留。

## 开放块请求

open 请求为 `{bundle,spec,settings,options}`。`bundle` 是既有 `inputs.json`；`spec` 明确 `refs/gaugeRef`、上下文和允许变化范围。默认保留选中的原生锁及固定件；只用 `releaseFixedRefs` 显式释放普通 `hard.fixed`，原生锁、显式机械锁及来源未知的旧锁不释放。同一器件具有多个锁来源时逐项保留。context/gauge 与保留固定位姿不一致时拒绝。独立块求解可释放板框/边缘锚点，不人为给局部形态附加毫米距离上限；保留实际器件几何、块内电气关系及显式机械约束。数值搜索域是计算边界，应在报告中说明，不能当作新的板框。

## 带铜模板请求

新请求为 `{bundle,groups,copperRules,refs?,settings,options}`；verify 另给 `transforms`，channels 另给 `channelPolicy`。`bundle` 复用准备层的 `inputs.json`，也可由 `--prepared` 指定，不重新填写板框与布局规则。

- `groups` 是已验证局部候选的刚性模板，可由 `createRigidBlock()` 生成；保留 `id/parts/pads/copper/rotations/base/fixed/keepouts/fanouts`、器件唯一归属及局部铜验证状态。
- `refs` 省略时覆盖公共 model 的全部器件；局部范围须明确给出，模板成员与所选范围完全一致。
- `copperRules:{copperGapMil,copperEdgeMil,source}` 来自上游布线/制造规则并记录依据。布局 model 不拥有铜净空与铜到板边规则，不在此推断这些值；全部几何单位为 mil。

## 准备回执与冻结输入

`prepare` 返回输入可用性、工程要求覆盖和当前布局几何结果。`summary.json` 提供摘要，`layout-input.json` 提供输入回执，`diagnostics.json` 列出具体问题，`inputs.json` 冻结本次输入。网名与距离检查不代表铜连接、电气或热设计已经通过。

## 块内布局输入与权限

使用公共 `prepare` 的冻结目录，或完整 `inputs.json`，不绕过器件身份、封装、焊盘归属、网络及支持条件核对。请求 `schemaVersion: 1`：

| 字段 | 实际含义 |
| --- | --- |
| `blockId`、`movableRefs` | 省略成员列表时按电路设计稿块派生，扣除实际锁、锁定焊盘与 `fixedRefs`；显式列表覆盖默认选择，仍校验块归属。二者至少提供一个；不生成刚性簇模板 |
| `allowedNeighborRefs`、`allowedNeighborBlockIds` | 明确允许让位的器件或其他电路设计稿块；块选择展开其未固定、未锁定成员。默认空，使用同一本轮区域，不按求解失败增加权限 |
| `fixedRefs`、`releaseFixedRefs` | 本轮固定成员；释放只允许有明确来源的 `hard.fixed`，不能释放原生或机械锁，也不移动锁定焊盘或文字的所属器件 |
| `region` | `mode`、`basis` 必填；`window` 指定 `boundsMil`，`available-space` 默认用真实板框内全部建模空间；`referenceBoundsMil` 仅记录借用比较范围 |
| `reservedRegions` | 有 ID、来源与边界的预留矩形；几何为 `physical`、`assembly` 或 `placement`；缺少装配视图时明确拒绝相应请求 |
| `relations` | 用 `relationId` 引用已编译的电路设计稿关系；或显式给 ID、依据及 `from/to`，端点用 `{ref,pin}` 或唯一 `{padId}`。独立测试焊盘只能作为固定上下文 |
| `relationSelection` | 默认 `explicit`；显式 `scope` 按可动成员派生相关基础关系，`relations` 只需列本轮例外；不扩大器件或邻居权限 |
| `labels` | 默认 `mode: separate`；兼容 `joint`。间距继承机械规则与既有模板，可明确给 `clearanceMil`、`maxOwnerDistanceMil`、`maxSeconds`；`additionalOwnerRefs` 在独立模式下额外允许重排这些器件的位号，器件位置、焊盘和原生文字锁仍保持 |
| `baselinePolicy` | 默认 `require-clean`；显式 `retain-outside-issues` 允许局部写回保留有基线证据、参与对象未变的同一外部问题；文字按 ID、本体按位号、焊盘按 ID 区分，文字移动许可不扩大本体影响范围。内部及跨块影响、新增或加重问题仍须通过；未知问题不视为旧问题，整板资格独立报告 |
| `routing` | `required`、需检查的 `nets`、明确层/宽度 `policy` 与工具 `options`；未完成必需检查不能写回 |
| `objective.retainSource` | 默认保留基础软目标；关闭时不能引用基础关系，既有硬条件仍保留 |

共用输入和合成规则见[基础规则与本轮变化](pcb-layout.md#基础规则与本轮变化)。关系字段如下：

| 字段 | 用法 |
| --- | --- |
| `relationId` | 电路设计稿 `extensions.pcbLayout.relations[].id`；读取对应实际焊盘、网络、依据及编译目标。可另给本轮 `id`，默认沿用引用 ID |
| `merge` | 引用默认 `inherit`，不接受另填权重或改变目标口径；`replace-objective`／`append-objective` 必须给本轮 `weight`。未引用关系只可显式追加，旧请求继续原追加语义 |
| `geometry` | 引用默认 `pad-position`，沿用公共焊盘位置；显式新关系默认 `bbox-center`，沿用旧请求的实际焊盘包围盒中心。改变引用口径须明确替换或追加 |
| `weight` | 本轮软权重；继承时报告公共编译后的实际权重。0 可关闭被引用的单条软目标，硬条件保持 |
| `maxDistanceMil`、`nonRegression.toleranceMil` | 本轮硬上限与显式非退化比较条件；与基础硬条件同时验收 |
| `basis`、`source` | 引用时默认复用上游依据和来源；新关系必须给依据。合成报告另保留稳定引用及原编译目标 |

```json
{
  "schemaVersion": 1,
  "blockId": "sensor",
  "fixedRefs": ["U_SENSOR"],
  "region": {"mode": "available-space", "basis": "本轮允许使用板内建模空白"},
  "relations": [{"relationId": "sensor-bypass"}],
  "labels": {"mode": "separate", "additionalOwnerRefs": ["U_SENSOR"]}
}
```

块和关系 ID 使用项目已有记录。重复引用、未知关系、附带端点与引用冲突时拒绝；不从用途文字补回地端或距离。多焊盘逻辑引脚保留完整映射，不能用附带单一 `padId` 缩窄引用。基础对应硬上限可作为引用的验收条件，报告单列其实际口径；`critical: true` 而无基础或本轮验收条件时仍标为未覆盖。多端点沿用最小焊盘对的曼哈顿代理，`measurement.pairs` 和 `maximumPairMil` 保留全部距离，`acceptanceScope` 明确它不是全焊盘连通验收。总分不抵消单项拒绝。

`available-space` 放宽的是工作窗口，实际板框、锁、固定器件与焊盘、外部文字、装配/操作包络、来源约束和预留仍保留。当前使用轴对齐包围盒，是保守搜索域，不保证枚举了所有物理可用空白；不移动已有铜，不自动让位邻居。

## 时间记录

solve 输出 `timing.json`：输入读取、准备、范围／关系整理、模型编译、器件与位号求解、独立审计、图与文件输出分别采样；未运行阶段为 `not-run`、耗时为 `null`。异常时保留原错误、失败阶段及已发生的时间，未得到候选不会伪造后图。参数或输出目录尚未确定的早期错误仍由原入口报出。

`seconds` 包含嵌套子阶段，`exclusiveSeconds` 扣除直接子阶段，`events.parent` 保存层级。审计可位于重建或预览中，预览中的写文件也是子阶段，不能把包含时间相加当总耗时。编译汇总含器件和位号模型两次采样；原 `stages` 的器件／位号耗时仍包括各自组装与审计开销。以 `timing.json.wallSeconds` 看入口内总时间，以外部命令墙钟补进程启动；最终计时文件自身写入及 stdout 不在其采样范围。准备／总结时的人工或 AI 时间另记，不混入求解器。

## 候选及冻结制品

`solve` 报告包含 `inputs/request/problem/solver/result/manifest.json`、阶段状态与逐条关系。`scope.selection` 记录成员派生和排除原因；`problem.objectiveComposition` 与候选审计记录基础和本轮目标的合成结果。独立模式另有 `body-candidate.json`、`label-problem.json`、`label-solver.json`。只有完整候选才有 `candidate.json`；其源指纹、完整对象及保持证明用于后续交接。

## 软件来源选择

项目配置的 `provider` 默认是 `easyeda-pro`。软件适配层转换层号、绑定和原生网表，并实现读取、移动、保存和回读。目前现场操作只实现 EasyEDA Pro。

## 候选池位置去重

批量候选的计算任务内，候选池用 `search.catalogGridMil` 做位置粗去重，未提供时默认 20 mil；此值不改变器件最小间距，实际采用值记录在 `run-parameters.json`。
