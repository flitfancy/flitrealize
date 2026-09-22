# PCB 网络配色当前约定

本文件记录当前接口与历史验证范围；正式调用以 [网络配色说明](references/providers/easyeda-pro/3.7-pcb-net-color.md)为准。

## 职责与输入

上层依据电路确定用途、类名和完整成员，并核对 EDA 中已存在的分类与规则。着色模块不判断用途、不建类或拆类，只按固定 kind 色表或显式 color 执行。

上层持久化输入为 mode=plan、实际项目/PCB UUID，以及 rules: [{name, nets, kind?, color?}]。nets 保存完整成员。已有 PCB 规则配置时，从规划结果取得配色请求，不独立维护第二套成员；只有配色配置时仍可直接调用着色入口。

pcb-routing-plan contractVersion=3：requireColor=true 强制输出配色请求，并要求实际目标和完整 netNames。整板请求检查全网覆盖；局部请求通过 selectNets 指定范围，仍需选择完整类。netNames 来自实际 PCB，不能从分类反向生成。输入缺项会报错；未启用新选项时保留原有纯布线及配色行为。

## 固定配色与调用

pcb-net-color contractVersion=4，支持 inspect / plan / apply。主电源柔红、接地灰蓝、逻辑供电蓝灰；I2C、SPI、UART、使能等使用固定信号色。同 kind 跨项目同色，显式 #RRGGBB 优先，没有名称推断、候补池或循环配色。完整色表只在调用文档展示、由着色核心实现。

pcb-edit 的配色流程为 plan → apply；apply 内完成规则保留、颜色回读及保存。不使用独立 verify/save 或 --resume-save。写入 alpha=255，回读为 1；API 回读不代替视觉判断。

规划命令使用 --full 时从 result.colorPlanRequest 取请求；报告中的路径为 response.result.colorPlanRequest。仅将该对象保存并交给 pcb-edit。

## 已有验证与实板记录

- 2026-09-20：包含新增网络清单与显式配色检查在内的 173 项 Node 测试全部通过，仓库 validate.py 校验通过；测试包含模拟上下游调用、回读与保存。
- 2026-09-19 的项目记录包含现场配色、回读和保存，原规则值保留。项目配置、目标身份与实板证据保留在对应项目，不随通用 Skill 发布。
- 本次修改只涉及上游校验和说明，不代表已在实板测试新校验。

## 历史变更

9 月 15 日曾使用名称推断、候补色及独立 verify/save；这些约定已经废弃。9 月 19 日改为固定用途/信号色与两步配色执行。9 月 20 日现有 contractVersion=2 增加部分分类缺失配色信息的检查，并清除了总结中的本机绝对路径；本次进一步增加显式配色要求和网络清单核对。
