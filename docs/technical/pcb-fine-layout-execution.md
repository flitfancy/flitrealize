# 公共块内布局执行接口

工程顺序与验收范围见 [3.5.2 块内布局](../3.5.2-fine-layout.md)。唯一外入口是 `scripts/pcb-layout.mjs fine`，也接受 `--mode fine`；旧 `pcb-fine-layout.mjs` 仅转发同一内部入口。

## 选择本轮入口

| 本轮任务 | 入口 | 需要什么 |
| --- | --- | --- |
| 生成新布局候选 | `solve` | 冻结输入和本轮请求；只在声明范围内重新排器件与位号 |
| 检查或应用已有公共完整候选 | `preflight`／`apply` | 项目和完整候选目录；不重新求解 |
| 接入其他来源的完整计划 | `adopt` | 同一基线、本轮请求和完整计划；重新验收后进入同一应用链 |

## 生成新候选

要重新安排本轮器件与位号时使用 `solve`。它读取冻结输入和请求，不读取或写入 EDA；完整候选生成后再进入下方检查与应用。

```text
node <skill>/scripts/pcb-layout.mjs fine --stage solve --project-root <project> --prepared <frozen-report> --request <request.json> --output <project-relative-report> --python <existing-runtime> --seconds 25 --preview comparison
```

## 检查与应用已有候选

已选完整公共候选目录包含 `inputs/request/candidate/result/manifest.json`。日常只给项目和该目录；入口读取这些配套制品并核验原契约，无需读源码、拼文件或生成项目临时脚本。

```text
node <skill>/scripts/pcb-layout.mjs fine --stage preflight --project-root <project> --from <complete-report>
node <skill>/scripts/pcb-layout.mjs fine --stage apply --project-root <project> --from <complete-report>
```

`preflight` 只读，复用 apply 的候选审计和原生 `checkPlan`；已有成功 apply 回执时复用原只读 verify。返回 `preflight.json`、窗口发现／宿主调用／结果组装前耗时及实际宿主请求数。宿主耗时包含传输和 EDA 工作，不等同纯网络或纯写入时间；最终报告写盘不包含在该墙钟字段中。来源不符时给出源指纹、对象字段和原生记录差异；原候选不变。仍须处理输出中的阻塞。

默认将项目与宿主会话路径解析为真实路径，选择项目内唯一活跃窗口，再由原生接口核对项目／PCB UUID；不能唯一确定时显式给 `--window-id`。输出默认进入项目 evidence，也可给 `--output`。

已有原 apply 回执时，检查或应用可加 `--receipt <原回执>`，直接复用并核对它；命令摘要返回 `executionReference`。未指定时兼容扫描项目 evidence；损坏记录先用同目录原执行输入核对目标，能确认属于其他文档时忽略；属于当前目标或身份不明时报告路径并停止。随后核对同一计划／快照／配置及保存证据，确定未保存时续原保存链，已保存时只读复核；目标存在未决写入、候选绑定变化或多份不同应用身份时停止。没有回执时不会因几何相同宣称已应用或已保存。必需路由证据按同一候选查找并独立验收；不唯一时显式给 `--routing-receipt`。证据移到默认目录之外时必须显式给出项目内回执。实现版本不匹配仍阻止继续执行，但独立确认的历史保存事实保留，不能据此宣称当前现场通过。通用失败分类、来源变化和恢复规则只在[共同执行规则](../0.3-easyeda-pro.md#失败与恢复)维护。


## 接入已有完整候选

公共块内布局报告直接用于 `apply`，无需再跑求解。项目脚本或其他布局阶段交出的完整 `plan`，可用 `adopt` 接入同一候选、应用及恢复契约；`--plan-file` 接受计划本身或含 `plan` 的候选对象。输入也可用 `--prepared <冻结目录>`。已有候选不匹配时先区分入口未找到、产物格式不兼容和实际能力缺失，不因格式不兼容另写应用或保存链。

```text
node <skill>/scripts/pcb-layout.mjs fine --stage adopt --project-root <project> --inputs <inputs.json> --request <request.json> --plan-file <complete-plan-or-candidate.json> --output <adoption-report>
```

接入须显式给出可动范围、工作区域及文字权限。计划必须包含同一源指纹、板框、全部器件目标姿态、原生位号及独立焊盘；身份、字体和字号由冻结现场核对，本体/焊盘及占位由原生几何重建，来源规则、固定范围、关键关系和文字间距重新验收，不采信原候选的 `valid` 或 `saved` 声明。固定器件的位号如需调整，使用 `labels.additionalOwnerRefs`；这不会释放器件或焊盘。

`adopt` 保留原计划及来源哈希，注明当前实现只进行了重新验收；不改写原生成器证据，不重新搜索或读取/写入 EDA，不宣称原候选由当前实现生成。通过后产生原格式的 `candidate/result/manifest.json`；后续 `route/apply/resume-save/verify` 仍走下述同一链。原生应用仍核对最新源，过期方案不能借接入覆盖人工修改。开放块、含铜模板或缺位号的部分计划不会因此成为完整可写候选。


## 输入与权限

冻结输入、本轮范围、文字权限和关系字段见[块内布局数据约定](../../schemas/pcb-layout.md#块内布局输入与权限)。

## 阶段与命令

```text
node <skill>/scripts/pcb-layout.mjs fine --stage route --project-root <project> --from <solve-report> --output <route-report> --python <existing-runtime> --seconds 30
node <skill>/scripts/pcb-layout.mjs fine --stage apply --project-root <project> --from <solve-report> --window-id <confirmed-window> --output <application-report> --routing-receipt <route-report/fine-routing-receipt.json>
node <skill>/scripts/pcb-layout.mjs fine --stage resume-save --project-root <project> --from <solve-report> --window-id <confirmed-window> --resume-save <application.json或原apply回执> --output <recovery-report>
node <skill>/scripts/pcb-layout.mjs fine --stage verify --project-root <project> --from <solve-report> --window-id <confirmed-window> --receipt <application.json或原apply回执> --output <verification-report>
```

写回和恢复仅在对应授权及目标核对后使用。求解不读取 EDA、不自动写入。当前预算为器件最多占 80%，文字使用剩余时间；每阶段与总墙钟耗时单列，进程启动及证据 I/O 是可观察开销。

### 时间记录与可选前后图

计时字段、嵌套时间及未运行状态见[时间记录约定](../../schemas/pcb-layout.md#时间记录)。

`--preview comparison` 为 solve 的可选输出，复用现有比较渲染器生成 `comparison.html`、`before.svg`、`after.svg`，默认不绘图。候选资格、来源与图输出状态分别记录；图失败保留候选和错误，不改变电气或几何验收。全场景前后图不增加真实走线或原生验证结论。

## 共用执行链

下面是求解到应用的完整顺序。`adopt` 以完整计划重新验收，跳过器件与文字求解；单次应用只构建一次候选上下文，进入原生写入时仍检查最新现场。

1. 冻结完整输入、请求及实现指纹，明确原生/机械/本轮固定来源。
2. 全模型求解，只放开允许成员；保留跨界真实端点及常量外部障碍。器件阶段不把文字与本体之间的空白包成障碍。
3. 固定器件方案，使用同一 CP-SAT 后端独立排实际文字矩形。字号、线宽、内容、归属及对象 ID 不变；外部文字原位保持。
4. 本体/焊盘、装配、区域、基础／本轮硬条件、显式非退化条件及独立文字检查通过后才生成完整候选；关键关系未覆盖时仍不能通过。离线与原生预检复用同一独立文字几何检查，旧联合模式保持旧语义。
5. 可选关键网试走线绑定同一完整候选，并独立重验连接及声明规则。当前是两层离线、焊盘包围盒代理；非零起点矩形板及委托地平面明确不在该桥接支持范围。
6. 显式应用前重验输入/代码/候选指纹及项目规则；原 preflight 读取当前现场，用已有验收检查原目标在当前环境的几何、空间和距离，再以源守卫进入 apply → verify → save → verify-after-save，不重复读取预检几何。候选保持原始绑定和比较基准；范围外保留本次写入前现场，随动位号纳入实际差异。回执字段见[布局验收回执](../../schemas/execution.md#布局验收回执)，现场变化判断按[共同规则](../0.3-easyeda-pro.md#现场边界与验证)。逐项报告保留变化、问题及对象证据；局部通过不代表整板合格。
7. 已应用但已知保存失败时，恢复使用原不可变回执、同一候选/快照/配置及其绑定的路由证据，只调用原 verify → save → verify，不重放 apply 或重新求路由。未知结果、并发保存和已保存仍阻断续存。已保存但回读失败使用 verify 阶段，只读复核原计划与当前现场，不再次保存。

## 应用回执与复用

本轮声明 `routing.required: true` 时，首次应用前必须取得同一候选的有效路由回执；未要求时可不提供。只要提供回执，就独立核验并保留在应用目录的 `fine-routing-receipt.json`。

回执的数据绑定见[布局验收回执](../../schemas/execution.md#布局验收回执)。

`--resume-save` 和 `--receipt` 接受 `application.json`、原生执行报告或原 apply 回执。旧回执没有块内布局证据关联时仍核对原计划／快照／配置；若要求试走线，另传 `--routing-receipt <原匹配路由回执>`，不改写旧回执或保存标记。实现版本变化仍需处理版本不符，不能把旧证据当作当前版本已经通过。

只读复核调用已有 `verifyLayout`；返回字段与保存证据的语义见[执行数据约定](../../schemas/execution.md#布局复核与保存字段)。

## 输出与失败

原生预检已明确在首个修改前拒绝时，公共入口核对原流程与独立apply阶段报告：请求已终结、结果为blocked、attempted为空且保存未启动，才将其认定为零写入失败并允许新的完整预检/应用。CLI/Bridge回执缺少请求或绑定也不放行；未决修改与保存复用核心状态判定。原报告保留，部分尝试、未知结果、缺失或矛盾回执仍须对账，不能只凭摘要的失败状态重试。

范围与回读的角度均以度为单位，按圆周最短差比较，保持各调用原有容差；等价角度及0°/360°接缝不算额外旋转，超出容差的变化仍须拒绝。原生源使用`angle`、SDK使用`Rotation`时，显式写入的器件与位号须分别核对SDK姿态和源码角度与目标计划一致；必需角度缺失、非法或矛盾时阻断，不用SDK值补齐。随器件旋转的所属属性仍须符合父器件预测的位置/角度，并保持内容、格式及`parentId`；可选焊盘角度未提供时保持未提供，不推断为0°。

候选与冻结制品的字段和文件组合见[输出约定](../../schemas/pcb-layout.md#候选及冻结制品)。

模型无效、有限预算耗尽、编译模型不满足、器件拒绝、文字阶段失败及最终拒绝分别报告。文字失败保留器件证据，不自动缩字、不扩大范围、不写 PCB。有限搜索失败不等于工程空间无解。

## 验证记录

块内布局、独立文字、已有完整计划接入、固定器件的独立位号权限、保存失败续存、只读复核，以及源／候选／路由证据变化、整批核验、等价角度、未决结果和并发保护由 Mock 回归覆盖。项目现场已完成完整独立文字候选接入、原生应用、保存、保存后 SDK 复核与磁盘设计记录对照；源变化拒绝及批准范围内重新接入也有现场证据。保存失败续存、未知结果及并发恢复等其他情形仍按 Mock 覆盖范围记录。代表核验何时重做按[共同触发条件](../0.3-easyeda-pro.md#代表核验)；这份记录不是每轮执行清单。

离线试走线及几何验收不代表实际铜、回流、均流、热或制造验收通过，也不代表整板完成。
