# 电路设计稿字段与检查器

建立或修改结构化输入、调用检查器时读本页；设计过程和命名规则见 [2.1](../2.1-schematic-contract.md)。字段与格式统一见[原理图数据约定](../../schemas/schematic.md)，本页保留用途和检查器调用。

## 电路设计稿保存什么

项目原理图意图保存在 `design/SCHEMATIC_CONTRACT.v1.json`，格式与字段语义见[原理图数据约定](../../schemas/schematic.md)。画布坐标和显示样式由 EDA 保存；设计理由、计算过程与取舍保留在项目主文稿。

字段、引脚标识、网络端点、要求及例外的语义统一见[原理图数据约定](../../schemas/schematic.md#电路设计稿字段)。

## 向 PCB 传递什么

| 电气意图 | 保存位置 |
| --- | --- |
| 功能块归属、接口、电源域及连接拓扑 | `blocks`、`interfaces`、`powerDomains`、`nets` |
| 电流、电压、压降、时序、回流、保护等要求 | 对应对象的 `constraints`，计算与依据放主文稿 |
| 去耦、采样、功率路径中需要影响布局的端点关系 | `extensions.pcbLayout` |
| 已确认的线宽、过孔、阻抗或长度要求 | 对应网络的约束及其计算条件 |

电气关系说明服务对象、相关引脚、网络和依据；字段见[PCB 布局数据约定](../../schemas/pcb-layout.md#电气关系)。器件用途本身不提供距离数值，有依据的上限另行填写。

布局阶段的事实归属与更新规则见 [2.1 向 PCB 传递什么](../2.1-schematic-contract.md#向-pcb-传递什么)。


## 检查器调用与结果

运行结构检查：

```text
node <skill>/scripts/action-runner.mjs run \
  --action schematic-contract-audit \
  --input-file <schematic-contract.json>
```

检查器核对字段、身份、引用、引脚网络归属、NC／DNC、电源域及接口关系。电路拓扑、额定值、默认状态和保护行为仍按资料与设计计算核验。

报告中的 `passed` 和 `conditional` 均可表示结构检查可继续；`conditional` 保留未决身份或依据。下一步能否执行，取决于本次范围所需的器件、映射和几何是否具备。
