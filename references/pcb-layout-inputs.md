# PCB 布局输入

用于准备布局数据、填写项目约束和调整搜索设置。操作命令见 [3.4 布局与空间](providers/easyeda-pro/3.4-pcb-placement.md)。

## 输入从哪里来

| 来源 | 提供的内容 | 谁来维护 |
| --- | --- | --- |
| Schematic Contract | 器件身份、逻辑引脚、网络、功能块、电气意图 | 复用上游设计 |
| 当前 PCB | 对象 ID、归属、位置、角度、层、锁定、焊盘与位号几何 | Provider 读取 |
| 项目布局配置 | 固定条件、接口方向、装配间距、操作空间和关联要求 | 按工程依据填写 |
| 搜索配置 | 起点、种子、预算、权重、候选数量 | 按本次目标调整 |

AI 补充工程意图和缺项；脚本读取已有数据、转换单位、关联对象并计算几何。当前坐标和网表不需要手工再抄一份。

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
| 器件与位号联合占位的最小间距 | 机械配置的 `clearanceMil` |
| 物理装配间距与明确的成对要求 | `assemblyRules`、`spacingPolicy` |
| 禁布区域及涉及的几何对象 | `spatial.zones`，`mode: "keepout"` |
| 纳入连接跨度评价的网络与测试点 | `connectivity` |
| 指标权重与搜索预算 | `comparisonWeights`、`search`、`initialization` |

当前求解器使用 `hard.boardBounds: null`，贴边相对于器件包络；固定板框、已有布线及其他支持范围见 [3.4](providers/easyeda-pro/3.4-pcb-placement.md#输入准备与候选求解)。区域的 `preferEmpty`／`preferFilled` 和局部组紧凑度目前作为观察指标，不参与总分。

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

`bypass`／`bootstrap` 形成去耦连接目标，`sense` 形成采样目标，`power-path` 形成功率连接目标；距离上限单独作为硬条件。端点距离按焊盘位置的曼哈顿距离（|dx| + |dy|）计算，单位 mil。该扩展的端点目前只支持器件引脚。用途文字不会自动生成距离数值，未能编译的要求仍保留在 Contract 和覆盖诊断中。字段定义见 [关系 schema](../schemas/pcb-layout-intent.v1.schema.json)。

## 间距和搜索设置

装配规则按封装提供 `marginMm`，或提供已确认的局部 `courtyard`。脚本结合封装和焊盘几何计算装配边界；使用装配规则时，每个器件的封装都应有对应规则。

物理间距配置使用 `schemaVersion: 2`、`mode: "active"`、`source: "assembly-courtyard"` 和 `geometry: "physical"`。其中 `bandRatios` 的 `rejectBelow`、`neutralMin`、`neutralMax` 需要填写。例如 `0.75 / 0.9 / 1.2` 表示基准的 75% 为拒绝界限，90%～120% 为不扣分区间；这是配置示例。

脚本从装配余量、绝对最小间距及成对要求计算物理硬下限 H，再令比例基准 B = H / rejectBelow。位号防撞单独检查。

评分由几何尺度归一化的连接距离与间距均匀度组成。可用权重是 `power`、`sense`、`bypass`、`connectivity`、`uniformity`；至少一个连接指标的权重大于 0。权重为 0 的指标不计入总分。

`search` 提供搜索步长、迭代数和偏好组；`search.profiles` 至少包含一组 `name`、`seed`，可用 `weightMultipliers` 调整该组权重。`initialization` 可选择 `existing`、`fresh` 或 `mixed`，并设置起点数量、种子与探索幅度。默认沿用现有布局、生成一个起点。

尺寸按字段单位填写：`*Mil` 使用 mil，装配余量 `marginMm` 使用 mm，角度使用度。

## 配置放在哪里

主配置默认是项目内的 `design/PCB_LAYOUT_CONSTRAINTS.v1.json`，也可用 `--config` 指定。它通过 `contractFile` 和 `mechanicalRulesFile` 引用 Contract 与机械配置，并提供 `hard`、`groups`、`connectivity`、`comparisonWeights`、`search`。机械配置需提供 `clearanceMil`；软件目标身份由现场读取并核对。

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

## 脚本自动取得和检查什么

Provider 读取位置、旋转、层、锁定、封装、焊盘与位号几何、对象归属和原生网表，转换为统一坐标与层用途。开发字段见 [Provider 数据接口](../development/action-system.md#布局数据接口)。

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
