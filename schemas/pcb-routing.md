# PCB 走线数据约定

本页集中网络规则、FR、预走线及地空间的现有公共字段与结果说明。调用及支持范围见[网络规划](../docs/technical/pcb-prerouting.md#网络规则规划)、[FR](../docs/providers/easyeda-pro/3.8-r-pcb-autorouting.md)和[预走线](../docs/technical/pcb-prerouting.md)。两种后端仍使用各自现有格式。

## 网络规则规划输入

```json
{
  "mode": "generate",
  "requireColor": true,
  "netNames": ["PWR", "GND", "CTRL"],
  "expectedProjectUuid": "<实际项目 UUID>",
  "expectedDocumentUuid": "<实际 PCB UUID>",
  "rules": {
    "units": "mil",
    "generalClearanceMil": 6,
    "qfnEscape": {"widthMil": 6, "maxLengthMil": 60},
    "classes": [
      {"name": "power", "priority": 1, "nets": ["PWR"], "trunkWidthMil": 25, "localWidthMil": 12, "viaHoleMil": 12, "viaDiameterMil": 24, "kind": "power"},
      {"name": "ground", "priority": 1, "nets": ["GND"], "widthMil": 20, "kind": "ground"},
      {"name": "control", "priority": 2, "nets": ["CTRL"], "widthMil": 8, "kind": "logic"}
    ],
    "routingOrder": ["power", "ground", "control"]
  },
  "segmentAssignments": [{"net": "PWR", "role": "trunk", "primitiveIds": ["<实际线段 ID>"]}]
}
```

数字只是格式样例。实际宽度、过孔、间距须按当前电流、压降、铜厚、温升及制造条件确定。每条网络只能属于一个类；priority 越小越先，同级保持输入顺序。可选 routingOrder 必须与排序一致，避免两套优先级冲突。可选 `selectNets` 只选择本次网络范围。

## 分类与配色覆盖

`pcb-routing-plan` contractVersion=3：配色任务设置 `requireColor: true`，必须提供实际项目/PCB UUID、完整 `netNames`，并为每个选中类提供 kind 或 color。全部缺少配色信息也报 `COLOR_KIND_REQUIRED`，不退回纯布线。requireColor 只接受布尔值，netNames 必须为非空、无重复且名称无首尾空白的字符串数组；对应错误为 `INVALID_COLOR_REQUIREMENT` 和 `INVALID_NET_INVENTORY`。

netNames 来自目标 PCB 的实际网络清单，不从 rules.classes 派生。提供 netNames 时：未传 selectNets 则检查分类覆盖全部网络，包括 GND；传了 selectNets 则只要求本次网络有分类，不要求未选网络都参与上色。输入类中的网络都必须存在于 netNames；遗漏或未知网络报 `NET_COVERAGE_MISMATCH` 并列出名称。selectNets 仍须为唯一、已分类的网络，且配色只能选择完整类。此检查证明与所提供清单一致，清单的目标归属和时效由上游确认。

省略 requireColor 或设为 false 时，选中类全无配色信息则仅生成布线计划；只要有一个提供 kind/color，就要求全部选中类都提供。false 不表示禁用已有配色。纯离线布线可省略目标 UUID 和 netNames；kind 的有效性由着色核心检查。

## 规划输出状态

输出 `sequence` 中每组状态都是 planned，不相信输入里的 completed/进度字段。

## 派生配色请求的读取位置

先确认命令成功，再取标准输出中的 `result.colorPlanRequest`；读取报告时取 `response.result.colorPlanRequest`。将该对象单独保存为项目配色输入，不能把整份输出或报告交给 pcb-edit。默认摘要不包含请求正文。

## 线段角色与派生请求

对已经存在的走线，先用 `pcb-trace-width inspect` 获取真实 ID，再按用途给 `segmentAssignments`：`trunk`、`local`、`signal` 或 `escape`。分别选对应 class 宽度或 qfnEscape 宽度；不从线段长度猜测角色。提供目标 UUID 后，输出 `widthPlanRequest` 可交给 `pcb-trace-width`；class 给出 kind 或 color 时输出带类名及完整成员的 `colorPlanRequest`，直接交给 `pcb-net-color`。上游传递已有分类与明确用途，颜色解释和色表只按 [3.4](pcb-operations.md#用途色表)。执行前须确认网络类已存在且成员完全匹配。`selectNets` 只选择某类部分网络时，不能为该类同时生成配色请求；仅生成局部布线计划时，在本次请求的所有选中类中省略 kind 和 color，保留源配置中的用途信息。生成请求不是写入。

## FR 规则与引出输入

沿用项目的 `design/PCB_ROUTING_EXECUTION.v2.json`：`units: mil`、目标 `projectUuid/pcbUuid`、按物理顺序声明的 `layers`、`nets[].endpoints`、`roles`、宽度/过孔及 `clearances`。不重抄网表或坐标。其他项目可通过 `--policy` 指定同一结构的输入。

- 角色给出 `name`、`endpoints`、`allowedLayers`、`widthMil`，功率主干还可给出 `localWidthMil` 和网络 `via`。
- `policy.layers[]` 可给 `{id,signalRoutingAllowed:false}` 禁止该层自动trace；实际允许层由角色 `allowedLayers` 或网络 `primaryAutoLayers` 明确声明，不凭15/16等原生层号猜地/电源用途。`ground_plane` 角色委托既有铺铜/接地流程。
- `load_current_main` 允许多个走线层时，角色必须给 `viaTransition:{sourceLayer,targetLayer}`，两者为允许集合中不同的声明层ID；同网 `via.minParallelLoadVias` 必须为正整数。缺失过渡或数量会明确拒绝，不使用某项目层号和隐含数量替代。角色只允许单层时可不声明过渡。
- 同网去耦、逻辑供电和小电流支路自动加入已有主干端点作为连接上下文；主干未连接时，小电流支路返回 `LOAD_PATH_NOT_READY`，不能替代负载通路。
- Kelvin 给出 `junctionEndpoint`、`destination` 和 `kelvinBranches[].pickup`。取样点必须位于实际源焊盘内，生成的支路不得在源焊盘外接触已有负载铜。
- Kelvin 求解时，原有同网负载铜及过孔也作为轮廓障碍，仅在源焊盘处留下取样窗口，其他同网端点不产生新的连接任务；原生写入仍保留全部原铜，并独立检查是否在焊盘外重接负载铜。
- `ordinaryCopperMil` 是硬性铜净空；`minimumSensitiveToSwitchCopperMil` 是可选硬性敏感线净空，`sensitiveToSwitchCopperTargetMil` 是优化目标。目标与最小值分别记录，不能靠文字状态猜测。优化目标未达到时报告警告，硬性约束不得放宽。
- 已审定引出沿用 `design/PCB_ROUTING_SEEDS.v1.json`，或用 `--escapes` 指定。引出写进同一临时求解模型并检查；缺少合法出口、并联过孔或可用空间时返回阻塞原因，不让 AI 临场拼坐标。
- 分阶段换层可给出 `transitionLayerWidthMil[net]`、`layerBridges[]` 和 `routingAnchors[]`。局部过渡不得低于该角色 `localWidthMil`；锚点必须与主干同宽，并由真实铜线段实现，不能成为实际 PCB 的虚构焊盘。普通引出/路径引出被 SES 回写时只计一次，重复过孔不能冒充并联数量。

## FR 层权限兼容

2.0兼容调整：旧规则若依赖隐含的15/16层用途，补充层权限和角色允许层；允许多层的载流主干补充过渡与并联数量。层权限缺失时仅按已声明角色层处理并保留兼容诊断，不自动推断预留层。

## FR 角色输出状态

角色状态从实际铜连接计算，不相信规划中的 completed 字段。`already-connected` 只表示本角色端点连接；不会把它当成载流、回流或制造验收完成。

## FR 输出制品

- `prepared.json`：冻结的 PCB、规则、引出与实现版本。
- 每个任务目录：DSN、SES、FR JSON/日志、候选和机器验收结果。
- `candidate-set.json`：有归属的写入对象及允许重布范围。
- `workflow.json`：每任务状态、警告/阻塞、各阶段计时、保存和回读结果。

`candidate-set.before.drc` 沿用 capture 的完整原生报告；原生事务保留 `drcBaseline/drc`，写后结果保留完整 `drc` 与 `drcSummary.comparison`。物理叶项按对象、规则上下文及完整内容作多重集比较，`physicalDrcCount` 不改为验收分数；非物理分组和任务连通另行报告。缺证据回退零物理违规要求。保存已确认但回读失败返回 `saved-readback-failed, saved:true`，仅保存失败返回 `save-failed, saved:false`；工作流不能因回读失败清除已确认的保存事实。具体边界见[自动布线验收](../docs/providers/easyeda-pro/3.8-r-pcb-autorouting.md#输出和验收)。

保存异常或不确定返回值表示 `outcome-unknown, saved:null, uncertainWrite:true`，原事务保持未决，不能续保存或重放 apply。`save-failed` 只覆盖明确未保存的结果。

## 预走线请求字段

| 最小字段 | 来源/用途 |
| --- | --- |
| `board.units/boardMil` | mil及明确零原点矩形尺寸，或已有规范化板边 |
| `board.pads/copper` | 保留物理焊盘ID和归属；prepare按ID复用对应 `copper.shape` |
| `policy.layers` | 声明层ID，公共用途用 `{id,purpose}` 对应；也可用 `options.layerMap` 明确转换 |
| `policy.nets` | 网络、声明线宽、源端与分支规则；已有角色按项目数据提供 |
| `options` | 格点/预算及明确铜边距、孔径/外径和间距 |

样例用 `top-copper/bottom-copper` 映射到声明的11/22层，展示编号可由调用者定义。复用render几何时不重新抄坐标，不凭其他软件适配层的原生层号猜转换；冻结后沿用该次层映射。

## 预走线公共请求

通用分析请求使用 `{mode,board,policy,options,...}`，board 为 mil 的焊盘、层、铜线、过孔和边界；保留每个物理焊盘 ID。扫描额外给明确 `outline`，不同板层按数据声明，不固定某项目层号。

## 冻结预走线输入与覆盖

Python A* 输入支持已保存的规范化 `boardMil/pads/segments/vias/nets`，亦可由 prepare 生成。每 pad 的 `shape/shapes/contactShapes` 区分保守障碍与真实端点接触；每 net 的源端、分支宽度、允许层、窄引出限长等由规则提供。新准备输入检查声明线宽，历史输入只回放原几何并报告未覆盖项。A* 严格限两个声明层；全层空位扫描和路径图可用于明确声明的多层板。

prepare消费 `policy.layers[].signalRoutingAllowed:false`：该层不得进入自动trace允许集合，声明角色/分支引用它会拒绝；`ground_plane` 仍委托接地流程。公共用途经 `{id,purpose}` 或 `options.layerMap` 显式转ID，角色 `allowedLayers` 与 `viaTransition` 的用途字段也使用这张映射；不猜其他软件适配层的层号。

两层A*不会因输入含主干过渡字段就取得FR的并联拓扑验收。冻结输入保留 `ruleCoverage.mainViaTransitionTopologyVerified:false`，`mainViaTransitionBackend:'FR'`；多层载流主干的过渡/正整数并联数量与实际铜验收按 [FR说明](../docs/providers/easyeda-pro/3.8-r-pcb-autorouting.md#输入和职责)。层映射、预留层检查及A*连通通过分别报告，不能互相替代。

## 地空间输入

候选默认替换输入铜；增量方式在请求中声明 `candidateMode:"additions"`。地网络、格点、整像素收缩、区域面积阈值、核心宽度、换层槽位搜索半径与孔规则均可配置，来源随报告保存；槽位搜索半径是诊断范围，不是功能块距离硬上限。

## 地空间输出

输出 `ground-space.json`、`ground-link-plan.json` 和可选采样数组，保留面积、分割区、核心宽度、孔槽位及相关线长／层占用。结果标明 `groundCopperCreated:false`、`groundConnectivityVerified:false`、`nativeWrites:0`。模型解释、用途与未覆盖条件见 [布局诊断](../docs/technical/pcb-ground-space.md)，实际铺铜与回流分别按 [3.9.1](../docs/3.9.1-pcb-ground-pours.md) 和 [3.9.2](../docs/3.9.2-pcb-grounding.md) 验证。
