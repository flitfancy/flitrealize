# EasyEDA Pro 单页新建 PCB

使用已保存、已完成本次检查的单页原理图，新建一个 PCB，确认它与来源原理图属于同一 Board 后导入。入口复用原宿主通道、现有 PCB 回读和网表比较器；不替换已有 PCB，不安排布局或走线，不重新完成上游电气审阅。

当前现场状态：新 Board 路径已在官方样例隔离副本通过创建、关联、导入、核对和保存。已有空 Board 路径通过 Mock 回归，尚未单独现场验收。详见下方范围。

```text
node <skill>/scripts/pcb-create.mjs --project-root <project> --input-file design/pcb-create.json --window-id <window>
node <skill>/scripts/pcb-create.mjs --project-root <project> --input-file design/pcb-create.json --window-id <window> --apply
node <skill>/scripts/pcb-create.mjs --project-root <project> --resume <runDir> --window-id <window>
```

默认模式只核对现场、Board 关系、冻结输入和生成计划，会在项目 `evidence/` 留下本地文件。`--apply` 才创建 PCB、建立明确关联、导入并保存。当前窗口必须已经打开下列单页原理图，不能用同名、默认或其他会话替代目标。

来源有两种可接受情况：

- 原理图尚未属于 Board：新建 PCB，再用公开 `dmt_Board.createBoard(原理图 UUID, 新 PCB UUID)` 创建关联两者的新 Board。
- 原理图已属于一个尚无 PCB 的 Board：用 `dmt_Pcb.createPcb(Board 名称)` 在该 Board 中新建 PCB。

原理图所在 Board 已有 PCB 时，计划就以 `SOURCE_BOARD_HAS_PCB` 停止，尚未创建新 PCB。需要保留旧板另做验证时，先在隔离工程中明确复制一份游离原理图，核对副本图页与源内容，再为副本生成新计划。本入口不会自动复制原理图或迁移已有 Board。

输入字段与来源身份见[新建 PCB 数据约定](../../../schemas/pcb-operations.md#新建-pcb-输入)。

## 结果与证据

安装版客户端的 `importChanges` 处理函数根据 Board 关系确定来源，没有读取传入的原理图 UUID。`force=true` 只自动应用导入变更，不能跳过“原理图与 PCB 必须在同一 Board”的前置弹窗。因此入口先回读 Board、原理图和新 PCB 的精确关系，再调用 `pcb_Document.importChanges(expectedSchematicUuid, true)`；仅传 UUID 不证明关联完成。

计划冻结原理图源、Board 成员和 PCB 清单。执行时核对清单未变、新 UUID 不属于旧 PCB，并检查原有 Board 的关联保持原样。新关联、打开后的目标和保存前的关联分别回读；来源、目标或原有关系不符时停止，不自动确认界面提示。来源 Board 缺 API、已有 PCB 或关系不一致，均在创建前报告具体错误。

正常路径只读取一次完整 PCB，复用现有网表与逻辑引脚／物理焊盘比较，并核对明确的封装名称及焊盘归属。保存前后使用同一软件适配层的源码指纹做轻量对账；源码变化进入异常处理，不重复求解或创建。网表、源码和详细差异留在 `runDir`，CLI 返回短摘要、文件入口、原生调用耗时和输入字节数，不向模型打印整份网表。

结果状态见[新建 PCB 输出约定](../../../schemas/pcb-operations.md#新建-pcb-结果)。

这些结果不证明铜连通、DRC、电路功能或可制造性。稳定结论按 [0.1](../../0.1-continuation.md)交给 3.1 布局准备，不自动更新主文稿。

## 重复调用与失败续接

第一次写入前建立项目内活动指针。已有创建记录时再次用输入文件 `--apply` 会要求使用原 `runDir`，不会再创建 PCB。`--resume` 只核对原记录对应的新 PCB 及已确认的 Board 关联；加 `--apply` 只可续完成已确认创建／导入后的保存，不重复创建、关联或导入。关联或导入失败时保留新对象和回执；缺少关联证据不会自动补做关联。旧计划没有 Board 检查时停止，不能沿旧的“游离 PCB 直接导入”假设继续写入。

未知写入先按 [0.3](../../0.3-easyeda-pro.md#失败与恢复)查询原请求。原回执没有终态、记录被修改或原会话不一致时停止续写；不删活动指针、伪造回执或自动撤销新对象。占用文件只保护本项目入口，不能保证其他执行者没有修改现场。当前入口不提供已有 PCB 更新、保铜／保布局、自动回滚或多页转换。

## 当前验证范围

代码回归覆盖精确工程／图页归属、两种 Board 路径、旧 PCB 阻断、关联回读、源指纹、网络和封装核对，以及创建／关联／导入未知时不重放。身份直接核对当前文档、原理图、新 PCB 与 Board 的工程归属，不依赖完整 `getCurrentProjectInfo()`。创建调用结果未确认时，报告保留 `creationAttempted: null` 和 `creation: unconfirmed`，不声称没有创建。

2026-10-12，客户端 V4.1.71，官方 FPC 样例的 `.eprj2` 隔离副本：用公开 API 复制并保存一份游离单页原理图，保留旧 Board／PCB 和此前空板；随后创建一个新 PCB 和明确关联的新 Board。导入约 0.75 秒完成，`saved:true` 且保存后源指纹一致。回读与保存前的原理图、独立项目库依据匹配：2 个器件、36 个焊盘及引脚映射、16 个赋网名称、精确封装名称。

该实例验证新 Board 路径的转换与保存，不证明铜连通、DRC、电气功能或制造适用性。已有空 Board 路径、多页、其他工程与其他客户端版本未取得本次现场验收。此前游离 PCB 导入等待的回执、空板和活动指针继续保留，不以此次新隔离实例改写旧操作状态。
