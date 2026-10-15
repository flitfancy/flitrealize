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

电气要求的来源、阶段口径、目标合成和验收见下文[电气要求与规则转置](#电气要求与规则转置)。

## 电气要求与规则转置

把已确认的电路要求转换为对应阶段可以计算和验收的规则。每条规则明确来源、作用对象、计算方式和使用目的；求解、候选比较与验收采用一致口径。

功能块布局用相关器件的中心直线距离进行简单评分；块内布局按实际需要细化焊盘及整组关系；实际走线验证铜连接和路径要求。各阶段不必使用全部指标。

### 一、输入来自哪里

- 电路设计稿：功能块、完整器件成员、引脚、网络、用途及已确认电气要求。
- 当前 PCB：实际器件与焊盘、逻辑引脚映射、位置、方向和外部环境。
- 项目配置：有依据的数值限制、比较权重和阶段设置。
- 本轮请求：调整范围，以及对已有目标的明确替换、追加或比较要求。

已有事实直接引用，不重复抄写。电气依据留在设计来源，实际几何取自当前 PCB；两者矛盾时核对受影响部分。

临时试排区域、旧位置和一次候选的距离，不自动成为长期电气限制。

### 二、按阶段转置

#### 功能块布局

沿用已确认的功能分组和连接关系，以相关器件的中心直线距离比较候选：

- 块内关系用于适度收拢，避免同一功能块过度分散。
- 块间关系用于安排各块的相对位置和大致分布。
- 同一关系不重复计分，不把所有器件两两相连。
- 共享地不产生整板器件相互吸引。

本阶段的一般连接评分不使用焊盘距离、支路差值或实际走线路径。板框、固定件、装配及项目已明确要求本阶段遵守的电气硬限制继续检查。

中心的取点方式、距离近似和阶段间距按[布局输入与求解参考](../docs/technical/pcb-layout-inputs.md#功能块阶段的求解评分与验收)维护，不改写上游电气关系。

#### 块内布局

在本轮成员和真实外部环境中，使用实际焊盘及相关端点，落实去耦、采样、功率等已声明关系。

根据具体要求选择两端距离、网络跨度或其他受支持的指标，不因器件属于某个功能块就自动增加所有指标。跨块端点保留，不能只裁出可动器件来计算。

#### 预走线优化与走线

预走线优化在换脚、旋转和调整出线空间时，保留受影响的电气要求。

实际走线依据网络、铜路径和布线规则验证连接与路径。布局距离通过，不自动代表实际回路、回流或其他电气性能通过。

### 三、一条要求怎样形成计算规则

每条要求依次明确：

1. 要改善或限制什么，依据是什么。
2. 涉及哪些器件、引脚、网络或已有关系。
3. 使用什么指标，如何取点、汇总，单位是什么。
4. 作为硬条件、优化目标还是观察指标。
5. 在哪个阶段使用，由什么检查确认结果。

例如，“两个功能块的连接更顺”在功能块布局中可由相关器件中心距离辅助比较；“电容靠近指定引脚”在块内布局中使用明确端点的距离；“整个网络不要过度分散”可使用网络跨度。

同一句工程要求可能需要不同阶段分别落实，但不能把不同阶段的指标混成一个含义不明的距离值。没有依据的数值不自动补成硬上限。

### 四、计算指标与当前支持范围

#### 器件中心直线距离

用于功能块布局的一般连接评分，根据已有分组和连接选取相关器件，计算其中心之间的直线距离。具体数值实现和误差说明见技术参考。

当前功能块布局已使用该口径。它用于安排大致分布，不表示真实焊盘连接长度。

#### 两端距离

用于明确端点之间的局部关系。当前公共电气关系采用曼哈顿距离，即横向距离与纵向距离之和，单位 mil。

上游关系使用焊盘位置；块内布局也支持明确使用焊盘包围框中心，实际口径随关系记录。不要把这里的曼哈顿距离与功能块布局的中心直线距离混用。

一个逻辑引脚对应多个物理焊盘时，保留完整映射。现有关系取两端集合中最近一对的距离，报告另列全部焊盘对及最大值。最近一对通过，不代表所有焊盘都满足距离要求或已经连通。

当前已支持两端距离目标、硬上限、显式非退化及独立验收。

#### 关系组最坏值

取一组已声明关系中最大的指标值，避免总量改善却留下特别差的一项。必须明确关系组成员和每条关系的计算方式。

“多条关系中取最大值”与“一条关系的全部焊盘对中取最大值”含义不同，分别声明。

当前开放块入口有关系组最坏距离的求解表达，尚未接成公共块内布局的完整输入、求解和独立验收链。块内布局报告中的 maximumPairMil 仅作观察。

#### 网络跨度

衡量指定网络端点的分散程度。当前指标为选定端点包围框的宽度与高度之和，单位 mil；相关的固定外部端点也参与计算。

当前普通布局及保留来源目标的块内布局已支持网络跨度软评分和独立重算，尚未接齐对应硬上限与验收。它不是实际铜路径长度，功能块布局的一般评分也不采用该指标。

#### 支路差值

比较指定支路之间同一种指标的差异。明确每条支路的端点或关系、支路指标的计算方法，以及支路之间的比较方式。

“每条支路分别不退步”不能代替“支路之间的差值满足要求”。当前公共布局尚未接齐支路差值的输入、求解与独立验收。

布局阶段采用几何代理时，走线后仍按实际路径要求验证。

### 五、硬条件、优化目标与观察

- 硬条件：必须满足的明确限制，例如有依据的距离上限。
- 优化目标：在满足硬条件后比较优劣，允许按声明方式取舍。
- 观察指标：用于解释结果，不自动参与求解或拒绝候选。

同一指标可以同时设置硬上限和优化目标，两者分别声明。已有问题及本轮变化按 [0.3](../docs/0.3-easyeda-pro.md)处理。

权重表示加权比较中的取舍，不代表严格优先级。当前公共目标主要采用加权和，尚未提供完整的主次分级优化。需要“主目标优先、其次再优化”的要求，不能只靠调大权重宣称已经实现。

后续支持分级优化时，明确目标层级和允许的退化范围，候选选择与验收使用同一规则。

### 六、现有输入分别放在哪里

| 输入位置 | 职责 |
| --- | --- |
| 电路设计稿的 blocks | 功能块用途与完整成员 |
| extensions.pcbLayout.relations | 有依据的引脚关系及可选距离上限，以稳定 ID 引用 |
| groups[].links | 项目明确声明的两端连接评分目标 |
| hard.pinDistanceLimits | 两端距离硬上限 |
| connectivity | 参与网络跨度评分的网络与端点 |
| blockCoupling.relations | 块间端点关系及受支持的距离要求 |
| spatial.relations | 几何对象之间的空间关系 |
| 块内布局请求的 relations | 引用基础关系，或声明本轮目标变化及验收条件 |

功能块阶段如何从已有连接派生中心评分，按对应编译规则执行，不要求重新填写一份中心连接表。

同一要求保留一个权威来源。上游已经生成的目标不从另一个入口重复添加；不同物理目的分别说明。不能只因两个字段都叫“距离”就视为同一约束。

最坏值、支路差值和分级目标的公共字段，随实际实现确定后再加入机器定义，不先把尚不支持的字段写成可执行输入。

### 七、现有上游关系格式

extensions.pcbLayout 使用 schemaVersion: 1，relations 中每条关系包含：

| 字段 | 含义 |
| --- | --- |
| id | 稳定且唯一的关系标识 |
| kind | bypass、bootstrap、sense 或 power-path |
| from、to | 器件逻辑引脚端点，使用 ref 和 pin |
| net | 两端所属的公共网络 |
| basis | 工程依据 |
| requirementId | 可选，引用电路设计稿中的 constraints.id |
| maxDistanceMil | 可选，有依据的距离硬上限 |

在现有基础关系编译中，bypass 和 bootstrap 进入去耦目标组，sense 进入采样目标组，power-path 进入功率目标组。阶段求解使用哪些评分按前述阶段口径确定。

关系类型不代表工具已计算完整电气性能。具体字段与允许值以[电气关系机器定义](pcb-layout-intent.v1.schema.json)为准。

### 八、基础关系与本轮变化

块内布局使用 relationId 引用已编译基础关系，复用端点、网络和依据。

relationSelection 默认 explicit；设为 scope 时，按本轮可动成员派生相关基础关系，保留固定外部端点，本轮只需填写例外。关系选择不扩大移动权限；基础目标是否保留由 objective.retainSource 控制。

目标合成沿用三种方式：

- inherit：保留基础目标及实际归一化权重，不增加第二条目标。
- replace-objective：用明确的本轮目标替换对应的一条软目标。
- append-objective：保留基础目标，明确追加本轮目标。

替换软目标不删除基础硬条件。新增硬上限与基础条件同时生效；nonRegression.toleranceMil 以原基线形成本轮比较条件，不自动成为长期安全上限。

引用关系默认使用 pad-position；改变为 bbox-center 时明确替换或追加。基础权重经过公共归一化，本轮 weight 直接参与声明目标，不能只比较填写数字。

未知或重复引用、端点冲突及非法字段明确报告。关闭 objective.retainSource 时不能同时引用基础关系。多焊盘映射不因附带单一 padId 而缩窄。

### 九、转置结果与验收

每条要求应能追溯：

- 来源和工程依据。
- 实际对象、端点及计算口径。
- 适用阶段，是否进入硬约束、优化目标或仅作观察。
- 继承、替换或追加后的有效规则。
- 验收结论及未覆盖内容。

复用现有准备回执、目标合成记录和候选审计。具体转换、求解、独立验收函数和测试位置由技术参考维护，不另建一份项目规则库。

验收按候选实际姿态重算。总分改善不能抵消硬条件失败，求解器成功也不能代替独立验收。当前 critical 关系没有基础或本轮验收条件时，仍标为未覆盖。

### 十、缺项与不支持

省略可选目标时，使用对应入口已明确的默认行为，不自行增加新要求。

明确声明但当前入口不支持的规则，说明具体缺失能力和影响，不静默忽略，也不擅自换成另一指标。必需条件无法表达或验收时，不能报告满足该条件；不受影响的其他工作按范围继续。

暂时不能转置的文字要求，保留在原设计来源及覆盖清单中。补齐能力时，同步接通输入、计算、独立验收和测试。

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

已有原生矩形板框时自动作为固定边界；同时配置边界时必须与现场一致。`hard.boardBounds: null` 表示不额外指定边界，两处均无板框时使用无板框布局。机械配置中的 `boardBounds` 参与同一一致性检查。支持的原生轮廓见 [3.5](../docs/providers/easyeda-pro/3.5-r-pcb-placement.md#输入准备与候选求解)。

有固定板框时，器件和焊盘占位、独立测试点及位号须位于板内，贴边相对于真实板边；装配余量用于器件间距，不自动成为板边退距。不支持器件越板悬伸。区域的 `preferEmpty`／`preferFilled` 和局部组紧凑度目前作为观察指标，不参与总分。

### 电气关系

字段含义、适用阶段、目标合成和验收统一见[电气要求与规则转置](#电气要求与规则转置)。以下示例使用现有关系格式：

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

### 间距和搜索设置

装配规则按封装提供 `marginMm`，或提供已确认的局部 `courtyard`。脚本结合封装和焊盘几何计算装配边界；使用装配规则时，每个器件的封装都应有对应规则。

物理间距配置使用 `schemaVersion: 2`、`mode: "active"`、`source: "assembly-courtyard"` 和 `geometry: "physical"`。其中 `bandRatios` 的 `rejectBelow`、`neutralMin`、`neutralMax` 需要填写。例如 `0.75 / 0.9 / 1.2` 表示基准的 75% 为拒绝界限，90%～120% 为不扣分区间；这是配置示例。

脚本从装配余量、绝对最小间距及成对要求计算物理硬下限 H，再令比例基准 B = H / rejectBelow。位号防撞单独检查。

普通搜索的评分由几何尺度归一化的连接距离与间距均匀度组成；CP-SAT 功能块阶段使用下文[功能块布局评分口径](#功能块布局软评分)，不计普通均匀度。可用权重是 `power`、`sense`、`bypass`、`connectivity`、`uniformity`；至少一个连接指标的权重大于 0。权重为 0 的指标不计入总分。

`search` 的搜索步长、迭代数、移动概率和偏好组由搜索后端校验；执行该后端时，`search.profiles` 至少包含一组 `name`、`seed`，可用 `weightMultipliers` 调整该组权重。公共输入准备、语义转换和 CP-SAT 不要求这些未使用的搜索参数，可省略 `search`。旧配置中的 `search.rotationDeltas` 仍是公共旋转约束，继续生效；新配置可按器件在 `hard.allowedRotationDeltasByRef` 声明。普通搜索的 `initialization` 可选择 `existing`、`fresh` 或 `mixed`，并设置起点数量、种子与探索幅度，默认沿用现有布局、生成一个起点。CP-SAT 功能块阶段不读取旧位置提示，直接在完整合法位置与朝向域中冷启动求解。

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

项目配置可选`roughLayoutPolicy`，只参与CP-SAT功能块阶段。其他布局后端不支持此配置。该阶段直接采用确认的功能块成员，默认阶段硬间距16mil；原有更严板框、固定件、装配及电气硬条件保留。细节布局不继承此阶段默认。

```json
{
  "roughLayoutPolicy": {
    "schemaVersion": 1,
    "clearanceMil": 16,
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

这是功能块布局参数示例，`clearanceMil` 是本阶段硬间距，其余软评分参数是项目的搜索偏好，均不代替制造要求。

- `clearanceMil`可选，覆盖本阶段16mil默认；有效硬间距取该值与项目显式机械硬间距的较大者。更严courtyard及成对要求保留，不改写原配置。
- `groupCompactnessWeight`可选，默认1，缩放同一确认块内已有稀疏中心关系；0.2表示五分之一。不另加组包围跨度，也不凭块成员生成所有器件对。
- `density`在错位粗网格内统计器件中心，超过软目标的数量参与平方惩罚。物理包络面积超过一个窗口的大件不参与中心计数，真实占位仍保留。边界窗口按面积折算软目标，错位网格减少器件挤在格点附近的偏差。这是器件分布代理，不是占用面积或可走线容量。
- `connectionSide`按真实焊盘及网络外部端点判定有效连接，排除未接网络及声明的排除网，再按最近的封装边分侧。连接达到项目等级的侧边产生软留白带，随许可旋转变化；其他器件进入该带会计分。它不逐脚生成出口，也不禁止关键局部器件靠近。
- 局部豁免来自电路设计稿中指定种类的关系；项目可额外给`exemptRefsByOwner: {"<主器件位号>": ["<关联器件位号>"]}`。声明豁免不能替代硬约束或电气验证。

候选保留`blockLayoutMetrics`、`roughLayoutMetrics`及`roughLayoutScore`；`comparisonScore`与`rankingScore`均为去重中心关系和明确rough分项的合计，不再另加semantic组跨度或普通uniformity。中心采用实际封装与所属焊盘包围框中心，使用16方向直线距离投影；相对误差上界1.936%，另加每对`sqrt(2)*resolutionMil`坐标误差。求解、解码及HTML重算同一公式，电气焊盘硬限独立保留。详见[阶段口径与能力范围](../docs/technical/pcb-layout-inputs.md#功能块阶段的求解评分与验收)。

## 开放块请求字段

| 小请求字段 | 来源/用途 |
| --- | --- |
| `spec.refs/gaugeRef` | 冻结输入中的本次成员与局部坐标锚点 |
| `criticalPairs[].left/right` | `{ref,id}`，ID取输入包的实际物理焊盘；可给同网 `net/weight` |
| `settings` | 本次预算与数值求解设置，如 `timeLimitSeconds/workers` |
| `options` | 候选数、尝试数等执行预算 |

样例的完整JSON给出可复制的字段结构。改用于本项目时只替换明确范围、焊盘ID和工程意图；不重抄器件坐标或上游规则，数值不是制造默认。

## 语义分组策略

功能块阶段始终直接采用已确认功能块完整成员，每个实际器件与独立焊盘须有唯一主块归属。缺失或重复归属拒绝，跨块关系不合并块；共享连接保留为跨块网络。`semanticPolicy` 可省略，只接受空对象或 `{ "groupScope": "declared-block" }`；CLI 的 `--semantic-policy` 文件和 Host Action 的同名输入使用同一检查。旧 `roles`、`associationWeights` 与 `groupScope: "relations"` 报 `RETIRED_SEMANTIC_POLICY`，未知字段报 `UNKNOWN_SEMANTIC_POLICY_FIELD`，其他非法类型或分组值也拒绝。迁移时删除旧参数，在 `Contract.blocks` 声明完整成员，在 `Contract.extensions.pcbLayout` 声明电气关系；输出不再生成 `legacyPolicy` 占位说明。成员仍柔性移动、旋转，不增加刚性模板或自动块区域分配。

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
| `labels` | 默认 `mode: separate`，也可选 `joint`。`clearancesMil: {body, pad, label}` 分别控制位号到所有器件包围框、焊盘、其他位号的最小距离，单位 mil，仅用于 `separate`；三项同时满足。省略的类别沿用旧有效值：`max(labels.clearanceMil ?? mechanical.clearanceMil, 该位号模板 minGapMil)`；显式类别值直接覆盖。`additionalOwnerRefs` 只增加位号移动许可；`maxOwnerDistanceMil`、`maxSeconds` 和 `orientation: "bottom-edge-to-owner"` 沿用原用途 |
| `baselinePolicy` | 默认 `require-clean`，要求初始干净；显式 `retain-outside-issues` 允许局部写回保留同一规则、对象身份和关系下，有基线证据且逐问题证明未加重的旧问题。参与对象未变是证明方式之一；文字按 ID、本体按位号、焊盘按 ID 区分，文字移动许可不扩大本体影响范围。活动及跨范围硬约束继续执行；新增、加重、未知、证据不足或本轮明确要求修复却未满足的问题仍拦截，整板资格独立报告 |
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

本轮排布可用 `labels: {mode: "separate", clearancesMil: {body: 3, pad: 4, label: 5}}`；只改器件框侧时写 `{body: 3}`，另外两类继承。器件框是原生封装包围框，可能包含焊盘；焊盘距离仍独立限制靠近程度，未识别纯本体轮廓。这组排布参数不改全局默认，焊盘几何间距不代替阻焊开窗或制造验收。

`labels.orientation: "bottom-edge-to-owner"` 会在本轮位号移动许可范围内，以 0°、90°、180°、270° 四向排布位号，使文字底边朝向所属器件中心。

块和关系 ID 使用项目已有记录。重复引用、未知关系、附带端点与引用冲突时拒绝；不从用途文字补回地端或距离。多焊盘逻辑引脚保留完整映射，不能用附带单一 `padId` 缩窄引用。基础对应硬上限可作为引用的验收条件，报告单列其实际口径；`critical: true` 而无基础或本轮验收条件时仍标为未覆盖。多端点沿用最小焊盘对的曼哈顿代理，`measurement.pairs` 和 `maximumPairMil` 保留全部距离，`acceptanceScope` 明确它不是全焊盘连通验收。总分不抵消单项拒绝。

`available-space` 放宽的是工作窗口，实际板框、锁、固定器件与焊盘、外部文字、装配/操作包络、来源约束和预留仍保留。当前使用轴对齐包围盒，是保守搜索域，不保证枚举了所有物理可用空白；不移动已有铜，不自动让位邻居。

<a id="时间记录"></a>

## 块内布局时间记录

`pcb-layout.mjs fine` 的 `solve` 输出 `timing.json`：输入读取、准备、范围／关系整理、模型编译、器件与位号求解、独立审计、图与文件输出分别采样；未运行阶段为 `not-run`、耗时为 `null`。异常时保留原错误、失败阶段及已发生的时间，未得到候选不会伪造后图。参数或输出目录尚未确定的早期错误仍由原入口报出。

`seconds` 包含嵌套子阶段，`exclusiveSeconds` 扣除直接子阶段，`events.parent` 保存层级。审计可位于重建或预览中，预览中的写文件也是子阶段，不能把包含时间相加当总耗时。编译汇总含器件和位号模型两次采样；原 `stages` 的器件／位号耗时仍包括各自组装与审计开销。以 `timing.json.wallSeconds` 看入口内总时间，以外部命令墙钟补进程启动；最终计时文件自身写入及 stdout 不在其采样范围。准备／总结时的人工或 AI 时间另记，不混入求解器。

<a id="候选及冻结制品"></a>

## 块内布局候选及冻结制品

`pcb-layout.mjs fine` 的 `solve` 报告包含 `inputs/request/problem/solver/result/manifest.json`、阶段状态与逐条关系。`scope.selection` 记录成员派生和排除原因；`problem.objectiveComposition` 与候选审计记录基础和本轮目标的合成结果。独立模式另有 `body-candidate.json`、`label-problem.json`、`label-solver.json`。只有完整候选才有 `candidate.json`；其源指纹、完整对象及保持证明用于后续交接。

普通搜索与功能块布局的候选文件按各自 `manifest.json` 中记录的名称读取，不使用本节固定的 `candidate.json` 约定。

## 软件来源选择

项目配置的 `provider` 默认是 `easyeda-pro`。软件适配层转换层号、绑定和原生网表，并实现读取、移动、保存和回读。目前现场操作只实现 EasyEDA Pro。

## 候选池位置去重

批量候选的计算任务内，候选池用 `search.catalogGridMil` 做位置粗去重，未提供时默认 20 mil；此值不改变器件最小间距，实际采用值记录在 `run-parameters.json`。
