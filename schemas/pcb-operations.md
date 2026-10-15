# PCB 操作数据约定

本页集中已有新建、板框、明确移动、改宽及配色字段。各操作的调用、支持范围与验收仍在 [PCB 操作导航](../docs/0.0-overview.md)。

## 新建 PCB 输入

```json
{
  "contractFile": "design/SCHEMATIC_CONTRACT.v1.json",
  "expectedProjectUuid": "<实际工程 UUID>",
  "expectedSchematicUuid": "<实际原理图 UUID>",
  "expectedSchematicPageUuid": "<当前图页 UUID>"
}
```

输入和电路设计稿的相对路径都从项目根目录解析，实际文件须位于项目内。原理图 UUID 和图页 UUID 分开填写；当前入口只接受恰好一个图页，不把单页回读冒充多页工程验证。当前纳入 PCB 的器件身份、封装和连接应已确定；结构审计与现场源码冻结不证明上游已经保存、DRC 或电气验证通过。

## 新建 PCB 结果

- `planned`：计划完成，未创建 PCB。
- `created-saved`：新 PCB 已导入并确认保存，当前覆盖范围内器件、封装名称、焊盘和网络核对通过。
- `created-differences`：有明确差异，不能视为布局输入已核对。
- `created-unverified`：创建或部分核对有结果，但保存或覆盖仍未确认；封装策略、未知格式等保留在报告。
- `blocked`／`outcome-unknown`：报告具体卡点、已取得的新 PCB UUID、Board 关联和保存事实；未知结果不等于没有创建。

## 矩形板框输入

矩形输入（单位 mil，原点按项目约定，常见左上 `(0,0)`）：

```json
{
  "mode": "plan",
  "expectedProjectUuid": "<实际项目 UUID>",
  "expectedDocumentUuid": "<实际 PCB UUID>",
  "rect": { "originX": 0, "originY": 0, "widthMil": 2755.9055, "heightMil": 1259.8425 },
  "lineWidthMil": 10
}
```

`2755.9055 mil = 70 mm`（`mil = mm / 0.0254`）。已有板框时默认拒绝；确认后才 `replace: true` 且仅允许替换唯一已有板框。plan → apply → verify → save 与其它 PCB 编辑入口一致。

apply 逐项核对原生回读路径与线宽，数值容差为 `1e-7 mil`。返回的 `verifyRequest` 和 `saveRequest` 携带原 `plan.path`、`plan.lineWidthMil` 及目标身份，后续沿这两份请求核对原计划；保存前发现差异时拒绝写入，保存后也核对路径和线宽。只给目标身份的独立 verify 仅检查板框数量、层与基础路径结构，不表示尺寸已经与设计计划对账。

## 明确移动输入

示例只展示字段，不是任何实际电路的推荐尺寸：

```json
{
  "mode": "plan",
  "expectedProjectUuid": "<实际项目 UUID>",
  "expectedDocumentUuid": "<实际 PCB UUID>",
  "boardBounds": {"minX": 0, "minY": 0, "maxX": 2000, "maxY": 1200},
  "lockedDesignators": ["J1", "U1", "L1"],
  "reservedRegions": [{"name": "display", "bbox": {"minX": 1400, "minY": 800, "maxX": 1900, "maxY": 1100}}],
  "clearanceMil": 5,
  "cellMil": 50,
  "scenarios": [
    {"name": "move-control-left", "groups": [{"designators": ["U3", "C8", "R9"], "dxMil": -100, "dyMil": 0}]},
    {"name": "move-control-down", "groups": [{"designators": ["U3", "C8", "R9"], "dxMil": 0, "dyMil": 100}]}
  ]
}
```

- 单方案不用 `scenarios`，直接给 `groups` 或 `placements: [{designator, x, y, rotation?}]`。未给 rotation 时保留当前旋转，不默认归零；组内只平移，保持相对关系。旋转仅支持相对当前角度的 90° 整数倍。
- `lockedDesignators` 和 `reservedRegions` 必须显式给出，确认没有约束时才用空数组。EDA 自身已锁定器件也不能移动；先核对锁定对象，不通过脚本解除锁。
- 现场所有 Region 的包围盒也作为保守障碍，可能比实际禁布范围大。尚未体现在 Region 中的屏幕、装配、天线、散热预留必须通过输入提供。

## 明确移动计划输出

plan 返回每个候选的 `issues`、`changedCount`、`space` 和可用的 applyRequest。apply 回读目标及未移动器件的已读属性；包围盒无冲突不等于焊盘间距、连通性、热设计或整板 DRC 合格。

## 指定线段改宽输入

```json
{
  "mode": "plan",
  "expectedProjectUuid": "<实际项目 UUID>",
  "expectedDocumentUuid": "<实际 PCB UUID>",
  "rules": [{"net": "PWR", "primitiveIds": ["<主干线段 ID>"], "targetWidthMil": 25}]
}
```

inspect 返回 `state.lines` 中的 ID、网络、层、端点、线宽和锁定状态。必须显式选择 ID，最多 200 段，不接受“全部同网统一加粗”的隐式范围。拒绝重复 ID、网络不符、非铜层对象和锁定线段。可加宽或减窄，因此每次目标值必须有设计依据。

## 网络配色输入

```json
{
  "mode": "plan",
  "expectedProjectUuid": "<实际项目 UUID>",
  "expectedDocumentUuid": "<实际 PCB UUID>",
  "rules": [
    {"name": "POWER", "nets": ["PWR"], "kind": "power"},
    {"name": "GND", "nets": ["GND"], "kind": "ground"},
    {"name": "CONTROL", "nets": ["CTRL"], "kind": "logic"}
  ]
}
```

名称和成员替换为现场值。项目持久化输入保留完整 `nets`，便于发现成员变化；临时调用可只给类名，只给 nets 时须唯一匹配已有类。类名和 kind 不带首尾空白，color 为 `#RRGGBB`；null 不表示恢复默认。显式 color 优先。

## 网络配色输出与色表

| 结果 | 主要字段 |
| --- | --- |
| 预览 | `status: planned`、`assignments`、预计 `changedCount`、`applyRequest` |
| 操作执行 | `status: applied` 或 `apply-failed`、`saved`；失败附原状态与已尝试类名 |
| 命令入口 | `ok/status/saved/steps/reportFile`；成功为 `verified`，实际数量仅在执行确认后报告 |

`assignments` 为 `{name, nets, hex, color: {r,g,b,alpha}}`；hex 是大写 HEX，回读 alpha 为 1。目标身份和成员在执行时再次核对。默认命令即使收到 `save:true` 也只预览。

## 用途色表

| kind | 用途 | 颜色 | HEX |
| --- | --- | --- | --- |
| `power` | 主电源/功率 | 柔红 | #D85C5C |
| `ground` | 接地 | 灰蓝 | #4E6FAE |
| `logic_power` | 逻辑供电 | 蓝灰 | #747985 |
| `logic` | 普通逻辑/控制 | 柔橙 | #D69A52 |
| `logic_orange` | 与 logic 同色 | 柔橙 | #D69A52 |
| `logic_green` | 明确指定的逻辑组 | 灰绿 | #648B65 |
| `logic_cyan` | 明确指定的逻辑组 | 灰青 | #4C929B |
| `switching` | 开关节点/电荷泵 | 灰紫 | #A568B5 |
| `analog` | 模拟采样 | 土黄 | #A08B4B |
| `audio` | 音频信号组 | 豆沙粉 | #C77996 |
| `i2c_scl` | I²C 时钟 | 松绿 | #28745B |
| `i2c_sda` | I²C 数据 | 钢蓝 | #4682B4 |
| `spi_sclk` | SPI 时钟 | 古铜 | #A87924 |
| `spi_mosi` | SPI 主发从收 | 薰衣草紫 | #9C7BD8 |
| `spi_miso` | SPI 主收从发 | 葡萄紫 | #8E4585 |
| `spi_cs` | SPI 片选 | 橄榄绿 | #708238 |
| `uart_tx` | UART 发送 | 深粉 | #D65A91 |
| `uart_rx` | UART 接收 | 靛蓝 | #4B5BB5 |
| `reset` | 复位 | 栗棕 | #7B4545 |
| `interrupt` | 中断/告警 | 玫紫 | #C2188B |
| `enable` | 使能 | 青绿 | #009B77 |
| `pwm` | PWM 控制 | 灰紫 | #81728F |
| `feedback` | 反馈 | 棕褐 | #8B5A2B |

同 kind 跨项目和调用顺序同色。UART TX/RX 以项目主控为参照，多控制器项目明确参照对象；复用管脚按当前用途选择 kind，不只凭名称判断协议。未定义 kind 且没有有效 color 时，写入前报错。
