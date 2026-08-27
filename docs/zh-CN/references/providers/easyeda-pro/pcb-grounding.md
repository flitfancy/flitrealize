> 本文件是英文参考文件 [pcb-grounding.md](../../../../../references/providers/easyeda-pro/pcb-grounding.md) 的中文只读镜像，供人工阅读和审阅。实际执行仍以英文源文件为准。
> 同步日期：2026-08-27（Asia/Shanghai）
> 英文源文件 SHA-256：`017C4FF403E29656F21137C27A37C9550951B48D6D0CE2E80A09AD6F19003FB1`

# EasyEDA Pro PCB 接地流程

只有 PCB 基础流程已经证明实际参考铜后才使用本流程。必要回流闭合与可选全局优化必须分开：

```text
只读盘点
  -> 必要局部/换层回流
  -> 重铺铜 + DRC + 回读
  -> 可选全局缝合
  -> 最终回读和钻孔证据
```

过孔更多不构成验收标准。

## 入口证据

- 精确项目和 PCB 文档身份；
- 来自 [pcb-foundation.md](pcb-foundation.md) 的已接受层/keepout/铺铜证据；
- 目标 GND 网络和过孔几何约束；
- 有工程依据的目标位号或信号换层；
- 当前布线、Region、过孔和源码状态。

## 1. 捕获接地盘点

使用 `scripts/actions/pcb-grounding-inspect.js` 作为只读盘点 Action。它枚举 API 可见的铺铜、Region、过孔和器件，按网络/层汇总铺铜，报告指定器件附近的 GND 过孔，并扫描文档和封装源码。源码扫描区分真正 keepout 与 `PROHIBITEDREGION` 显示 token，避免把 API 查询缺口当成空板。

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-grounding-inspect.js --input-file <inspect.json>
```

把 `inspectionFingerprint`、API/源码覆盖、铺铜网络、可见 keepout 几何和未解析封装证据与过孔计划一起保留。`detailLevel: summary` 仍会扫描所有对象；只有需要精确图元几何时使用 `full`。手工修改布局、布线、铺铜、Region、过孔或 keepout 会使指纹过期。

## 2. 闭合必要回流

使用 `scripts/actions/pcb-ground-vias.js` 执行有数量上限的必要过孔事务。`mode: generate` 解析精确位号和 GND 焊盘号，读取实时坐标/外形，并提出正交偏移候选。它过滤已解析板级 keepout 和已有/规划过孔，但板框包含关系与局部铜皮/焊盘/走线间距得到独立证据前仍保持阻塞。无法证明 fallback 半径的自定义焊盘几何也阻塞。

`mode: plan` 接受外部确定的精确候选列表。两条路径都要求文档身份、检查指纹、网络、孔径/外径、板框包含证据和局部间距证据。Dry-run 检查过期状态、API/源码覆盖、keepout 相交与过孔碰撞，只有全部候选可执行时才返回 `applyRequest`：

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-ground-vias.js --input-file <plan.json>
```

Apply 使用完全相同的 dry-run 指纹，单次最多创建 200 个过孔，逐个回读，确认原有过孔保留，并返回定向回滚请求。它不会保存或重铺铜。源码中存在而 API 无法解析的 keepout 会阻止 apply，不能绕过。

必要回流包括器件、去耦、散热、ESD 和信号换层参考过孔。每个接受候选都需要原因和锚点；仅仅靠近器件不能证明必要性。

## 3. 优化前验证

必要过孔写入后：

- 重铺受影响铜皮；
- 运行已配置 DRC；
- 回读精确新增图元和相关填充状态；
- 目检目标回流区域；
- 保存与接受源版本配对的钻孔证据。

缺少必要回流时保持 blocker 或明确未决证据。第一次 apply 成功不等于可以进入全局优化。

## 4. 规划可选全局缝合

使用 `scripts/actions/pcb-ground-stitching.js` 作为 `plane-grid`、`edge-fence` 和 `signal-transition-return` 的只读规划器。它要求已声明的正片 GND 实际铺铜，解析板框与阻断 Region，盘点焊盘/走线/圆弧/过孔，给候选评分，但绝不创建过孔。

对于 `edge-fence`，它参数化累计周长，执行硬几何过滤，用附近已有 GND 过孔作为覆盖种子，并且只有能缩小最大环形空档时才增加确定性最远点候选。`maxCount` 是上限，不是填满目标。

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-ground-stitching.js --input-file <generation.json>
```

不得把规划器输出直接交给 apply。把 `nextRequest` 送入 `pcb-ground-vias.js` 的 `mode: plan`，由第二次 dry-run 重新检查指纹、源码/API keepout 覆盖和过孔碰撞。非凸板框的 edge fence、不支持的板框/Region/焊盘/圆弧几何继续阻塞。内电层 Region 需要独立源码证据，才能视作已完成第一阶段地结构。

## 出口检查点

接地状态只有同时具备以下证据才能接受：

- 必要回流依据和精确过孔回读；
- 可选缝合依据与必要工作明确区分；
- 当前铺铜、DRC、源码和钻孔证据；
- 原有过孔与未受影响连通性保持；
- 未解析项具有明确 blocker 或已接受风险。

只读诊断不保存、不重铺铜，也不修改持久规则。任何手工编辑都会使冲突的缓存请求过期。
