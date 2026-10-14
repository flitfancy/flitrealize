# 原理图操作数据约定

本页集中现有批量放件、绑定及连接请求与结果说明。调用和恢复分别见 [2.3](../docs/providers/easyeda-pro/2.3-component-batch.md) 与 [2.4](../docs/providers/easyeda-pro/2.4-schematic-connect.md)。未在原说明中完整定义的操作对象不在此补造格式。

## 批量放件路径

输入文件和电路设计稿都位于当前项目内。本入口的 `--input-file` 和 `contractFile` 相对路径都从项目根目录解析，绝对路径也须位于项目内。连接入口显式使用 `--path-base project` 时采用相同规则；其默认 `legacy` 模式保留旧路径解释，见 [2.4 输入](../docs/providers/easyeda-pro/2.4-schematic-connect.md#输入)。示例中的 UUID 必须替换为现场实际值；这里只示意已有电路设计稿中的位号，不是可直接放置的器件样本。

## 批量放件输入

```json
{
  "contractFile": "design/SCHEMATIC_CONTRACT.v1.json",
  "expectedProjectUuid": "<实际项目 UUID>",
  "expectedDocumentUuid": "<实际原理图 UUID>",
  "designators": ["R1", "R2", "C1"],
  "batchSize": 10,
  "selections": {
    "R1": {
      "libraryUuid": "<已确认的库 UUID>",
      "deviceUuid": "<已确认的器件 UUID>",
      "pinMap": {"1": ["1"], "2": ["2"]}
    }
  },
  "layout": {"originX": 600, "originY": 500, "blockGap": 180}
}
```

- `designators` 明确本次已确认的器件，必须唯一且属于电路设计稿。电路设计稿自带的 `bindings.easyedaPro` 优先；已有绑定时通常不再填写 `selections`。显式选择和 `pinMap` 的键依照当前电路设计稿，不照抄示例。

## 绑定证据

- resolver 的 `libraryEvidence` 随绑定回执保留，区分对象读取状态与身份核对结论。符号／封装的明确覆写优先于器件库默认关联；缺少库 UUID 时不猜系统库，明确矛盾进入既有未解决项，缺可选证据不冒充已验证。此检查不自动修改库或当前器件。

## 批次可选参数

- 可选 `selections`、`pinMaps`、`searchMapping` 直接传给现有绑定 resolver；可选 `catalog`、`layout` 直接传给现有布局生成器。按位号索引的参数仅包含本批次器件，布局字段的单位/语义沿用原生成器。

## 批次大小

`batchSize` 为 1–50，默认 10。

## 批次结果与制品

一次运行返回 `runDir`，位于 `evidence/schematic-components-<唯一 ID>/`，其中：

- `transaction.json`：该次事务的输入/脚本版本、步骤和创建回执索引；新批次同时保留原输入、电路设计稿快照和 JSON 语义指纹，不刷新旧证据。
- `prepared.json`：冻结的绑定与放置计划及原有器件基线。
- `before.esch`：写入前完整源码备份。
- 按步骤编号的 `*-input.json` / `*-report.json`：可核对输入、确定终态、创建 ID、回读、保存结果。
- `after-*.esch`：保存后的源码回读。

默认计划成功是 `planned`，放置和保存成功是 `placed-saved`。成功记录被再次续接且现场仍匹配时返回 `already-completed`，不重复放件或保存。只读返回 `saved: null, saveChecked: false`；`recordedSaved: true` 只表示历史保存回执，不证明当前保存状态。`verification` 保留实际库身份覆盖的 `unknown` 等限制，`drc: not-run` 明确未验收整图；脚本成功不是网络连接或板级功能证明。

## 连接请求

```json
{
  "expectedProjectUuid": "actual-project-uuid",
  "expectedDocumentUuid": "actual-schematic-uuid",
  "contractFile": "design/SCHEMATIC_CONTRACT.v1.json",
  "strategy": "endpoint-stubs",
  "stubLength": 8,
  "grid": 1,
  "connectionTolerance": 0.1,
  "deferredComponents": [],
  "providerPinNoConnect": [],
  "reflow": {
    "blocks": [{ "name": "input", "members": ["J1", "R1"], "columns": 1 }],
    "layout": {
      "unit": "easyeda-schematic",
      "componentSpacing": 72,
      "blockSpacing": 210,
      "attachmentSpacing": 140,
      "mainFlow": ["input"],
      "attachments": []
    }
  }
}
```

位号、分组、尺寸、标识类型与参数来自本项目。坐标单位同现有原理图操作，布局配置直接复用 `schematic-reflow` 的格式。

`designators` 可显式限定本次器件范围；没有该字段时检查整个电路设计稿。报告记录范围，局部完成不等于整张图所有设计已实现。严格 DRC 仍检查当前整张图。

现场缺少电路设计稿声明的器件时默认报错。确实属于其他阶段的器件可列入 `deferredComponents: [{"designator":"TP1","reason":"PCB 阶段实现的裸露焊盘"}]`；延后项保留在覆盖报告里，不默认忽略所有未放器件。

不连接标记从电路设计稿的 `classification: "no-connect"`／`"dnc"` 及 EasyEDA `pinMap` 派生，电路设计稿保留两种声明的区别。符号额外物理引脚可用 `providerPinNoConnect: [{"designator":"SW1","pin":"4","reason":"已核对该型号，此脚为不连接的固定脚"}]` 明确补充。仅在查清用途后填写；当前悬空或已有 NC 状态本身不构成依据。NC／DNC 与电路设计稿网络端点冲突会阻止写入。

## 连接路径解释

使用嵌入的 `contract` 或 `contractFile` 二选一。新调用建议显式使用 `--path-base project`：`--input-file` 和 `contractFile` 相对路径都从项目根目录解析，与 [2.3 放件入口](../docs/providers/easyeda-pro/2.3-component-batch.md#输入)一致；绝对路径也须位于项目内，联接的实际目标越出项目时拒绝。输入文件可以放在项目子目录，电路设计稿路径仍以项目根目录为准。

未传 `--path-base` 或传 `--path-base legacy` 时完整保留旧规则：输入相对命令运行目录，`contractFile` 相对输入 JSON 所在目录；绝对路径保持原义。已有配置不需要改写。切换到 `project` 时明确调整旧的 `../design/` 等路径，不按文件是否存在自动猜测基准。报告的 `inputPaths` 记录所用基准和实际文件路径。以下示例用于 `project` 模式。

## Value 写入与证据

放置计划从电路设计稿的 `identity.value` 取得 `Value`；没有独立 value 的准确器件使用 `identity.mpn`，不允许正常放件流程留下空 Value。创建时与位号一起写入并回读 Value；若器件带有 LCSC 供应商编号，则优先反查并写入供应商标准库的 Value，避免工程描述值触发“属性与供应商编号不匹配”，而完整工程参数继续保留在电路设计稿。

供应商 Value 使用实际采用值写入创建回执并精确回读。查询成功且唯一匹配的库记录没有 Value 字段时，可使用电路设计稿值并记录回退来源；明确空 Value、查询失败或匹配不唯一时保留为缺口。供应商返回的整包属性包含 Symbol、Footprint、Designator 等结构字段，不能直接写入 `otherProperty`。

## 导线与标识显示

连接方式确定后，由脚本完成连线、网络标识和文字放置。使用短线与网络标识时，导线必须显式携带电路设计稿网络，导线的 `NET` 是唯一可见名称；创建 `netflag` 或 `netport` 时传入 `showName: false`，在首次保存前关闭标识自身的 `Name` 显示。同一端点只保留一份可见网络名称，不把重复文字保存后再交给布局阶段修复。网络标识单次 Apply 最多 30 个，较大功能块由调用方按不超过 30 个的稳定批次顺序计划、写入和回读。

## 重排单位与文字几何

读取原生符号与文字的实际边界，`layout.gridStep` 默认 5 原理图单位（50mil）；完整器件束统一平移，不能单独取整线端而脱离引脚。NC 的源属性通过原生引脚 ID 归属到器件，坐标与布尔状态在保存后分别核对。沿用源文件已有字号；显式字号覆盖需要已知原字号进行测量换算。

## 接地路线选项

- 重排配置 `layout.groundElbows: false` 可保留已有接地路线。
- 连接配置 `allowGroundElbows` 默认允许复核标准接地折线，设为 `false` 时禁用。
- `maxExistingStubLength` 限定已有直线或路径的总长，为大于 0 且不超过 1000 的原理图单位数值；省略时沿用 `stubLength`。标准接地折线的接受长度下限按[原理图重排的固定折线规则](../docs/providers/easyeda-pro/2.2-schematic-workflow.md#2-按电路设计稿完成连接)计算，不因该值较小而拒绝标准折线；长度判定仍包含本次网格与连接容差。
