# 原理图数据约定

现有机器定义保持原文件与版本：[电路设计稿](schematic-contract.v1.schema.json)、[放置计划](schematic-placement-plan.v1.schema.json)、[现场快照](schematic-snapshot.v1.schema.json)。本页集中原有字段语义；设计和实现流程仍见 [2.1](../docs/2.1-schematic-contract.md) 与 [2.2](../docs/providers/easyeda-pro/2.2-schematic-workflow.md)。

## 电路设计稿字段

### 顶层结构

以下字段需要存在。数组中明确没有对应项目时使用 `[]`；尚未确定的内容记录未决状态。

| 字段 | 内容 |
| --- | --- |
| `kind`、`schemaVersion` | 固定为 `flitrealize.schematic-contract` 和 `1` |
| `project` | 项目标识 `id`、修订号 `revision`；可附标题和来源制品 |
| `blocks` | 功能块的 `id`、`purpose`、成员位号 `components` |
| `powerDomains` | 电源域的 `id`、供电网络 `sourceNet`、返回网络 `returnNet`，以及已知电压范围 |
| `interfaces` | 接口 `id` 和 `signals`；信号包含 `name`、`net`、`direction`，可附电压域和默认状态 |
| `components` | 器件身份、封装、引脚、用途和 BOM／PCB 范围 |
| `nets` | 网络的 `name`、`kind` 和端点 `endpoints` |
| `constraints` | 对具体对象的设计要求、依据和确认状态 |
| `exceptions` | 有意例外及其理由、适用对象和确认状态 |

### 器件

每个 `components[]` 条目包含：

| 字段 | 填写方式 |
| --- | --- |
| `designator`、`role` | 唯一位号及器件在本电路中的作用 |
| `identity` | `selection` 为 `exact`、`generic` 或 `unresolved`。准确器件填写 `mpn` 及已确认的制造商信息；通用器件填写 `value` 或 `description` |
| `footprint` | `selection` 为 `exact` 时填写 `name`，为 `policy` 时填写 `policy`；未确定为 `unresolved` |
| `pinMapCoverage` | 声明引脚范围：`critical` 为关键引脚，`complete` 为完整逻辑引脚 |
| `pins` | 本项目声明的引脚条目 |
| `includeInBom`、`includeInPcb` | 明确是否纳入 BOM 和 PCB |

数值放在 `identity.value`；额定值、公差和选用条件可写入 `identity.description`。需要独立检查的限制放在 `constraints`，关联对应器件。程序需要读取的附加结构使用约定的 `extensions`。

`pinMapCoverage` 是设计声明，实际引脚及封装焊盘仍通过数据手册和软件适配层映射核对。

### 引脚与网络

单个引脚条目示例：

```json
{
  "number": "1",
  "function": "VIN",
  "classification": "power-in"
}
```

- `number` 是本器件内唯一的引脚标识，网络端点通过它引用引脚。它可以采用已确认的编号，也可以采用明确的逻辑标识。
- `function` 描述该引脚的功能；多个引脚可以有相同功能，仍保留各自标识。
- `classification` 描述类别，可选值见结构定义。`no-connect` 和 `dnc` 引脚不分配网络。
- `safeDefault` 可记录上电、复位或失控时要求的状态。

网络端点使用 `{component, pin}`。例如 `{"component": "U1", "pin": "1"}` 引用 U1 的 `pins[].number: "1"`；同一引脚只属于一个网络。

软件适配层的 `bindings` 保存库身份及电路设计稿引脚与原生引脚的映射。具体操作见 [器件绑定与放置](../docs/providers/easyeda-pro/2.3-component-batch.md)。引脚功能来自准确器件资料，实际画出的连接由 EDA 回读确认。

### 要求、例外与依据

`constraints[]` 使用 `id`、`type`、`appliesTo`、`requirement`、`evidenceState`。要求中的数值注明单位和适用条件，来源可放在 `evidenceRefs`。

`appliesTo` 是目标对象数组，指向已声明对象。例如：

```json
{"appliesTo": [{"kind": "component", "id": "U1"}]}
```

`exceptions[]` 使用 `id`、`rule`、`appliesTo`、`rationale`、`evidenceState`，说明有意例外及其依据。

`evidenceState` 为 `OPEN`、`CONDITIONAL` 或 `PASSED`，分别表示未决、有条件成立、已有依据确认。确认状态针对所记录的要求，不代表整个电路通过验收。
