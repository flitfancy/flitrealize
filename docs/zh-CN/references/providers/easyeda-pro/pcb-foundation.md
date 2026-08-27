> 本文件是英文参考文件 [pcb-foundation.md](../../../../../references/providers/easyeda-pro/pcb-foundation.md) 的中文只读镜像，供人工阅读和审阅。实际执行仍以英文源文件为准。
> 同步日期：2026-08-27（Asia/Shanghai）
> 英文源文件 SHA-256：`78D0FE508B7E18C1C0171D99DF03ACE89922B9C7D8883D1EDDDB24F0DDBAB892`

# EasyEDA Pro PCB 基础流程

按以下顺序建立 PCB 物理基础：

```text
层计划 -> 实时几何 -> 功能性 keepout -> 实际参考铜
```

本流程不增加接地过孔，也不优化全局缝合；实际铜检查点通过后才继续 [pcb-grounding.md](pcb-grounding.md)。

## 入口证据

- 精确项目和 PCB 文档身份；
- 由设计支撑的铜层数量与有序角色；
- 板框和当前物理层叠 capture；
- 预期参考/平面网络；
- 功能性净空涉及的器件/封装身份；
- `SKILL.md` 要求的实时写入授权状态。

减少层数可能移除已有内层内容，必须单独进行破坏性评审。

## 1. 检查并实现层计划

`scripts/actions/pcb-layer-stack.js` 可检查、规划、应用、验证并立即回滚层结构。动作数据与 helper 源码分离：

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-layer-stack.js --input-file <action.json>
```

计划声明有序层角色、内层名称/类型、预期平面网络，以及物理层叠或阻抗目标来源。设置角色或平面网络名不等于存在铜。物理层叠数值仍由项目/板厂拥有，本 Action 不覆写。

检查点输出：

- 已验证的层身份和顺序；
- 已接受的物理层叠证据或明确 unknown；
- 不存在无法解释的内层内容丢失。

## 2. 解析功能性禁铜几何

不要只靠板级 Region 查询推断所有限制。先用 `scripts/actions/pcb-component-geometry.js` 检查精确实时器件和封装几何，包括焊盘、槽、文档源码上下文和图元包围盒。

按工程目的分类：天线净空、声学开孔、裸露焊盘散热区、电气隔离、安装/机械净空或厂商规定 keepout。封装庭院层或丝印外框不自动等于铜 keepout。

用 `scripts/actions/pcb-functional-keepouts.js` 规划、应用、验证或回滚精确且有数量上限的板级 Region。请求拥有几何、层、规则类型、来源和受保护几何指纹。Apply 返回所有新增 ID 和只含这些 ID 的回滚请求；不会保存或重铺铜。

如果 API 不回传 Region 名称或归一化显示线宽，验证精确 ID、几何、层、规则、锁定状态和受保护不变量，不依赖外观字段。未解析功能几何继续阻塞。

## 3. 创建并证明实际参考铜

板框和功能性 keepout 解析后才使用 `scripts/actions/pcb-ground-pours.js`。它支持 inspect、plan、apply、verify 和定向 rollback。Action 捕获受保护的器件/走线/过孔不变量，每次创建一个有边界的铺铜，重建后回读铺铜边界和生成的 `Poured` 填充对象；不会保存文档。

边界存在不能证明铜皮已经生成。必须检查填充路径，并用每个关键 keepout 探针点同时验证实际铜皮和净空轮廓。先在一层建立早期检查点再扩展。多边形与包含关系 API 仍是 Beta 且随版本变化，只使用特性检测和经过测试的解析几何 fallback；不支持的几何继续阻塞。

## 出口检查点

产生或保留：

- 已验证的有序铜层状态；
- 受保护功能几何指纹；
- 精确铺铜 ID、网络、层、边界和生成填充证据；
- blocker/unknown，而不是猜测的几何；
- 供接地流程使用的当前源/文档指纹。

任何写入后都要在相关层重铺铜、运行已配置 DRC、回读精确新增图元、目检目标区域，并把钻孔输出与接受的源版本配对。手工编辑会使受影响计划过期。

删除、大范围导入、自动布线、替换封装或批量规则修改仍是独立且需明确授权的可恢复流程。
