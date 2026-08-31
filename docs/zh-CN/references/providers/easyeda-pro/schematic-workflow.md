> 本文件是英文参考文件 [schematic-workflow.md](../../../../../references/providers/easyeda-pro/schematic-workflow.md) 的中文只读镜像，供人工阅读和审阅。实际执行仍以英文源文件为准。
> 同步日期：2026-08-29（Asia/Shanghai）
> 英文源文件 SHA-256：`4339650DEB54AEA6E2C9A7A2544CDDE14BB8B4C3236BA577A82E5A70A18D8711`

# EasyEDA Pro 原理图工作流

当通过审计的 `SchematicContract` 需要在 EasyEDA Pro 原理图中实现或对账时，读取本工作流。

## 一个边界，三个 Provider 阶段

可移植层与 Provider 层之间的边界刻意保持很窄：

```text
SchematicContract -> Contract Audit
                         |
                         v
                 EasyEDA Components -> Connect -> Finalize
```

正常目录只暴露 `schematic-contract-audit` 和三个 workflow：`easyeda-schematic-components`、`easyeda-schematic-connect`、`easyeda-schematic-finalize`。细粒度 Action 保持内部可测试，但用户不必手工拼出一条很长的流水线。

`SchematicContract v1` 保持可移植。EasyEDA 库 UUID、原生 ID、符号几何、API 能力和写入行为从 Audit 边界以后开始。其他 EDA 可以使用不同原生 primitive 实现相同三个结果。

## 1. Components：解析、布局、放置

### 解析原生器件

Resolver 直接消费 Contract，并返回以位号为键的瞬态 `providerBindings` map。已有 `components[].bindings.easyedaPro` 可作为项目缓存；不建立单独的 BindingSet 制品。

对 exact 器件，只有在搜索结果未截断、候选唯一、具备原生 library/device ID，并且 MPN、制造商、exact footprint 等所有必需且已报告字段都按规范化后的完整相等匹配时，才允许自动选择。子串匹配永远不能自动选择。generic 值、证据缺失、多个 exact 匹配或超过 25 个结果都要求显式选择。库搜索失败与零结果分开报告。

Contract 语义引脚可通过 `pinMap` 映射到一个或多个原生符号引脚。Map 的键必须是已声明 Contract pin，值不能为空。只有 Contract 显式提供 EasyEDA 预期物理引脚数时才检查 pin count；不能把语义 pin 数量当成封装物理 pin 数量。

### 计算布局

内部 layout Action 把 Contract 与解析出的 binding 合并为 `SchematicPlacementPlan v1`。其 `cluster-bbox-v3` 算法：

- 默认保持 Contract block 顺序，除非显式覆盖；
- 每个主器件建立一个 cluster，并吸附声明 `near` 的从属器件；
- 遵守连接器方向提示；
- 优先使用 catalog 的符号宽高和引脚侧几何；
- 缺失时依据声明 pins 和 footprint 提示保守估算，并报告 fallback；
- 对 90/270 度旋转交换占用宽高；
- 使用完整 cluster/block 包围盒和布线路径间隙排布；
- 坐标吸附到配置网格；
- 剩余矩形重叠作为 blocker 报告。

PCB footprint 外形只可作为 fallback 提示，不能代表原理图符号几何。重要或异常符号应在 layout catalog 中提供实测几何。如果 API 无法在放置前提供，可先宽松地暂存放置，捕获现场符号后再执行有边界的 move；不能把推测几何称为现场证据。

### 事务式放置

Placement plan 会拒绝 binding 缺失、位号重复或已占用、文档错误以及超过 50 个器件。Apply 创建器件、设置位号、保护全部已有 primitive ID，并返回由指纹约束的 rollback request。Verify 总是检查创建 ID、位号、坐标、旋转、镜像和 BOM/PCB 标志。EasyEDA 无法可靠回读原生库身份时，该覆盖报告为 `unknown`，既不制造假失败也不制造假通过。放置不会自动保存。

当前布局局限是有意保留的：它不优化交叉、不从第一性原理理解模拟信号流、不在放置前测量任意符号图形，也不完成全图自动布线。它给出安全、确定、且不隐藏不确定性的第一版排布。

内部交接是直接的：resolver 的 `providerBindings` 和 `bindingFingerprint` 与 Contract 一起进入 layout；layout 的 `placementPlan` 带 `expectedDocumentUuid` 进入 component-place plan；只有它返回的 `applyRequest` 才能进入 apply。

## 2. Connect：捕获、规划端点、写入

Connect 从新的 `SchematicSnapshot v1` 开始，其中包含文档/项目身份、器件、可获得的绝对 pin 坐标、导线折线、已知网名以及分开的覆盖和指纹。知道网名不等于知道端点成员关系。

内部连接规划器把每个 Contract 语义端点通过 PlacementPlan pin map 展开，在现场原生 pin 中解析，并提出一段短的正交端点 stub。方向取现场器件锚点到现场 pin 向量的主轴，stub 末端吸附网格。

提出 stub 前，算法用有限容差计算 pin 到每一条现场导线线段的距离，因此能识别线段中部接触，而不只识别顶点：

- 相同已知网：记录为已连接并跳过；
- 不同已知网：作为冲突阻止；
- 接触无名导线：因连通性未知而阻止；
- 器件、映射、pin、坐标缺失或 no-connect：阻止。

生成的连接计划是瞬态内部 Action 结果，不是公开 schema。它绑定 Contract、PlacementPlan binding、Snapshot、文档和现场几何指纹。`schematic-wire-create` 在 apply 前重新捕获相关几何，每批最多创建 20 条 flat polyline，并通过 `sch_PrimitiveWire.get(id/get(ids))` 验证每个新 primitive。`getAll()` 只作为全局覆盖证据；目标 ID 回读可以通过，同时把全局枚举单独报告为 inconsistent 或 unknown。

可选 net flag/port 使用独立 plan/apply/verify/rollback 事务。Apply 前拒绝重复请求的符号。支持的 flag 为 `Power`、`Ground`、`AnalogGround`、`ProtectGround`；支持的 port 为 `IN`、`OUT`、`BI`。

Connect 当前只创建端点 stub 和命名 flag，不处理长距离布线、junction 拓扑、bus、层次标签，也不能证明整个 Contract 网表已实现。未来 router 可以替换内部规划器，而无需修改 Contract 边界或写入/回读安全。

这里的内部交接同样直接：inspect 的 `snapshot`、Contract 和当前 PlacementPlan 进入连接规划；瞬态结果进入 wire-create plan；只有返回的 apply request 才执行写入。Flag items 是显式可选输入，不能只根据网名推断。

## 3. Finalize：检查、保存、校验

Finalize 捕获最后一次 Snapshot，把 save request 绑定到选中文档和指纹，显式保存，再运行原理图 DRC。`verify` 只运行 DRC、不保存，并报告 `saved: false`。Save 没有伪 rollback。ERC/DRC 仍只是已配置连通性证据，不证明电气额定值、拓扑或系统行为。

Inspect 结果和选中文档 UUID 进入 save-verify plan；只有其返回的 apply request 可以保存。

## 事务与超时规则

所有写入 Action 都需要显式写授权和匹配的现场文档。手工修改、文档变化、几何变化、binding 变化或必需能力变化后，apply/rollback request 都会过期。Rollback 只删除本次请求创建的 primitive 并证明对应 ID 已消失，不能声称恢复整个文档。

用 `FLITREALIZE_EDA_ACTION_TIMEOUT_MS` 设置 Host 侧截止时间。新启动的 Bridge 默认继承该值，除非另设 `EASYEDA_BRIDGE_REQUEST_TIMEOUT_MS`。写入超时后必须先 inspect 并对账再重试，因为超时不能证明现场 EDA 代码已经停止。

EasyEDA 原理图坐标单位为 10 mil。Net flag 是 component primitive，不是 wire。`sch_Drc.check(strict, false, false)` 返回布尔值，而不是详细 issue 列表。
