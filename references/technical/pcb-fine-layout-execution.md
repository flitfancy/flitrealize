# 公共细布局执行接口

工程顺序与验收范围见 [3.5.2 细布局](../3.5.2-fine-layout.md)。唯一外入口是 `scripts/pcb-layout.mjs fine`，也接受 `--mode fine`；旧 `pcb-fine-layout.mjs` 仅转发同一内部入口。

## 正常检查与应用

已选完整公共候选目录包含 `inputs/request/candidate/result/manifest.json`。日常只给项目和该目录；入口读取这些配套制品并核验原契约，无需读源码、拼文件或生成项目临时脚本。

```text
node <skill>/scripts/pcb-layout.mjs fine --stage preflight --project-root <project> --from <complete-report>
node <skill>/scripts/pcb-layout.mjs fine --stage apply --project-root <project> --from <complete-report>
```

`preflight` 只读，复用 apply 的候选审计和原生 `checkPlan`；已有成功 apply 回执时复用原只读 verify。返回 `preflight.json`、窗口发现／宿主调用／结果组装前耗时及实际宿主请求数。宿主耗时包含传输和 EDA 工作，不等同纯网络或纯写入时间；最终报告写盘不包含在该墙钟字段中。来源不符时给出源指纹、对象字段和原生记录差异；原候选不变。仍须处理输出中的阻塞。

默认将项目与宿主会话路径解析为真实路径，选择项目内唯一活跃窗口，再由原生接口核对项目／PCB UUID；不能唯一确定时显式给 `--window-id`。输出默认进入项目 evidence，也可给 `--output`。

已有原 apply 回执时，检查或应用可加 `--receipt <原回执>`，直接复用并核对它；命令摘要返回 `executionReference`。未指定时兼容扫描项目 evidence；损坏记录明确报告路径，不跳过可能的未决写入。随后核对同一计划／快照／配置及保存证据，确定未保存时续原保存链，已保存时只读复核；目标存在未决写入、候选绑定变化或多份不同应用身份时停止。没有回执时不会因几何相同宣称已应用或已保存。必需路由证据按同一候选查找并独立验收；不唯一时显式给 `--routing-receipt`。证据移到默认目录之外时必须显式给出项目内回执。实现版本不匹配仍阻止继续执行，但独立确认的历史保存事实保留，不能据此宣称当前现场通过。通用失败分类、来源变化和恢复规则只在[共同执行规则](../0.3-easyeda-pro.md#失败与恢复)维护。


## 输入与权限

使用公共 `prepare` 的冻结目录，或完整 `inputs.json`，不绕过器件身份、封装、焊盘归属、网络及支持条件核对。请求 `schemaVersion: 1`：

| 字段 | 实际含义 |
| --- | --- |
| `blockId`、`movableRefs` | 省略成员列表时按 Contract 块派生，扣除实际锁、锁定焊盘与 `fixedRefs`；显式列表覆盖默认选择，仍校验块归属。二者至少提供一个；不生成刚性簇模板 |
| `allowedNeighborRefs`、`allowedNeighborBlockIds` | 明确允许让位的器件或其他 Contract 块；块选择展开其未固定、未锁定成员。默认空，使用同一本轮区域，不按求解失败增加权限 |
| `fixedRefs`、`releaseFixedRefs` | 本轮固定成员；释放只允许有明确来源的 `hard.fixed`，不能释放原生或机械锁，也不移动锁定焊盘或文字的所属器件 |
| `region` | `mode`、`basis` 必填；`window` 指定 `boundsMil`，`available-space` 默认用真实板框内全部建模空间；`referenceBoundsMil` 仅记录借用比较范围 |
| `reservedRegions` | 有 ID、来源与边界的预留矩形；几何为 `physical`、`assembly` 或 `placement`；缺少装配视图时明确拒绝相应请求 |
| `relations` | 用 `relationId` 引用已编译的 Contract 关系；或显式给 ID、依据及 `from/to`，端点用 `{ref,pin}` 或唯一 `{padId}`。独立测试焊盘只能作为固定上下文 |
| `relationSelection` | 默认 `explicit`；显式 `scope` 按可动成员派生相关基础关系，`relations` 只需列本轮例外；不扩大器件或邻居权限 |
| `labels` | 默认 `mode: separate`；兼容 `joint`。间距继承机械规则与既有模板，可明确给 `clearanceMil`、`maxOwnerDistanceMil`、`maxSeconds`；`additionalOwnerRefs` 在独立模式下额外允许重排这些器件的位号，器件位置、焊盘和原生文字锁仍保持 |
| `baselinePolicy` | 默认 `require-clean`；显式 `retain-outside-issues` 允许保留未移动外部的同一问题，内部及新问题必须通过，仍分别报告整板资格 |
| `routing` | `required`、需检查的 `nets`、明确层/宽度 `policy` 与工具 `options`；未完成必需检查不能写回 |
| `objective.retainSource` | 默认保留基础软目标；关闭时不能引用基础关系，既有硬条件仍保留 |

共用输入和合成规则见[基础规则与本轮变化](pcb-layout-inputs.md#基础规则与本轮变化)。关系字段如下：

| 字段 | 用法 |
| --- | --- |
| `relationId` | Contract `extensions.pcbLayout.relations[].id`；读取对应实际焊盘、网络、依据及编译目标。可另给本轮 `id`，默认沿用引用 ID |
| `merge` | 引用默认 `inherit`，不接受另填权重或改变目标口径；`replace-objective`／`append-objective` 必须给本轮 `weight`。未引用关系只可显式追加，旧请求继续原追加语义 |
| `geometry` | 引用默认 `pad-position`，沿用公共焊盘位置；显式新关系默认 `bbox-center`，沿用旧请求的实际焊盘包围盒中心。改变引用口径须明确替换或追加 |
| `weight` | 本轮软权重；继承时报告公共编译后的实际权重。0 可关闭被引用的单条软目标，硬条件保持 |
| `maxDistanceMil`、`nonRegression.toleranceMil` | 本轮硬上限与显式非退化比较条件；与基础硬条件同时验收 |
| `basis`、`source` | 引用时默认复用上游依据和来源；新关系必须给依据。合成报告另保留稳定引用及原编译目标 |

```json
{
  "schemaVersion": 1,
  "blockId": "sensor",
  "fixedRefs": ["U_SENSOR"],
  "region": {"mode": "available-space", "basis": "本轮允许使用板内建模空白"},
  "relations": [{"relationId": "sensor-bypass"}],
  "labels": {"mode": "separate", "additionalOwnerRefs": ["U_SENSOR"]}
}
```

块和关系 ID 使用项目已有记录。重复引用、未知关系、附带端点与引用冲突时拒绝；不从用途文字补回地端或距离。多焊盘逻辑引脚保留完整映射，不能用附带单一 `padId` 缩窄引用。基础对应硬上限可作为引用的验收条件，报告单列其实际口径；`critical: true` 而无基础或本轮验收条件时仍标为未覆盖。多端点沿用最小焊盘对的曼哈顿代理，`measurement.pairs` 和 `maximumPairMil` 保留全部距离，`acceptanceScope` 明确它不是全焊盘连通验收。总分不抵消单项拒绝。

`available-space` 放宽的是工作窗口，实际板框、锁、固定器件与焊盘、外部文字、装配/操作包络、来源约束和预留仍保留。当前使用轴对齐包围盒，是保守搜索域，不保证枚举了所有物理可用空白；不移动已有铜，不自动让位邻居。

## 阶段与命令

```text
node <skill>/scripts/pcb-layout.mjs fine --stage solve --project-root <project> --prepared <frozen-report> --request <request.json> --output <project-relative-report> --python <existing-runtime> --seconds 25 --preview comparison
node <skill>/scripts/pcb-layout.mjs fine --stage adopt --project-root <project> --inputs <inputs.json> --request <request.json> --plan-file <complete-plan-or-candidate.json> --output <adoption-report>
node <skill>/scripts/pcb-layout.mjs fine --stage route --project-root <project> --from <solve-report> --output <route-report> --python <existing-runtime> --seconds 30
node <skill>/scripts/pcb-layout.mjs fine --stage apply --project-root <project> --from <solve-report> --window-id <confirmed-window> --output <application-report> --routing-receipt <route-report/fine-routing-receipt.json>
node <skill>/scripts/pcb-layout.mjs fine --stage resume-save --project-root <project> --from <solve-report> --window-id <confirmed-window> --resume-save <application.json或原apply回执> --output <recovery-report>
node <skill>/scripts/pcb-layout.mjs fine --stage verify --project-root <project> --from <solve-report> --window-id <confirmed-window> --receipt <application.json或原apply回执> --output <verification-report>
```

写回和恢复仅在对应授权及目标核对后使用。求解不读取 EDA、不自动写入。当前预算为器件最多占 80%，文字使用剩余时间；每阶段与总墙钟耗时单列，进程启动及证据 I/O 是可观察开销。

### 时间记录与可选前后图

solve 输出 `timing.json`：输入读取、准备、范围／关系整理、模型编译、器件与位号求解、独立审计、图与文件输出分别采样；未运行阶段为 `not-run`、耗时为 `null`。异常时保留原错误、失败阶段及已发生的时间，未得到候选不会伪造后图。参数或输出目录尚未确定的早期错误仍由原入口报出。

`seconds` 包含嵌套子阶段，`exclusiveSeconds` 扣除直接子阶段，`events.parent` 保存层级。审计可位于重建或预览中，预览中的写文件也是子阶段，不能把包含时间相加当总耗时。编译汇总含器件和位号模型两次采样；原 `stages` 的器件／位号耗时仍包括各自组装与审计开销。以 `timing.json.wallSeconds` 看入口内总时间，以外部命令墙钟补进程启动；最终计时文件自身写入及 stdout 不在其采样范围。准备／总结时的人工或 AI 时间另记，不混入求解器。

`--preview comparison` 为 solve 的可选输出，复用现有比较渲染器生成 `comparison.html`、`before.svg`、`after.svg`，默认不绘图。候选资格、来源与图输出状态分别记录；图失败保留候选和错误，不改变电气或几何验收。全场景前后图不增加真实走线或原生验证结论。

### 接入已有完整候选

公共细布局报告直接用于 `apply`，无需再跑求解。项目脚本或其他布局阶段交出的完整 `plan`，可用 `adopt` 接入同一候选、应用及恢复契约；`--plan-file` 接受计划本身或含 `plan` 的候选对象。输入也可用 `--prepared <冻结目录>`。已有候选不匹配时先区分入口未找到、产物格式不兼容和实际能力缺失，不因格式不兼容另写应用或保存链。

接入须显式给出可动范围、工作区域及文字权限。计划必须包含同一源指纹、板框、全部器件目标姿态、原生位号及独立焊盘；身份、字体和字号由冻结现场核对，本体/焊盘及占位由原生几何重建，来源规则、固定范围、关键关系和文字间距重新验收，不采信原候选的 `valid` 或 `saved` 声明。固定器件的位号如需调整，使用 `labels.additionalOwnerRefs`；这不会释放器件或焊盘。

`adopt` 保留原计划及来源哈希，注明当前实现只进行了重新验收；不改写原生成器证据，不重新搜索或读取/写入 EDA，不宣称原候选由当前实现生成。通过后产生原格式的 `candidate/result/manifest.json`；后续 `route/apply/resume-save/verify` 仍走下述同一链。原生应用仍核对最新源，过期方案不能借接入覆盖人工修改。开放块、含铜模板或缺位号的部分计划不会因此成为完整可写候选。

## 共用执行链

下面是求解到应用的完整顺序。`adopt` 以完整计划重新验收，跳过器件与文字求解；单次应用只构建一次候选上下文，进入原生写入时仍检查最新现场。

1. 冻结完整输入、请求及实现指纹，明确原生/机械/本轮固定来源。
2. 全模型求解，只放开允许成员；保留跨界真实端点及常量外部障碍。器件阶段不把文字与本体之间的空白包成障碍。
3. 固定器件方案，使用同一 CP-SAT 后端独立排实际文字矩形。字号、线宽、内容、归属及对象 ID 不变；外部文字原位保持。
4. 本体/焊盘、装配、区域、来源规则、每条关键关系及独立文字检查完成后才生成完整候选。离线与原生预检复用同一独立文字几何检查，旧联合模式保持旧语义。
5. 可选关键网试走线绑定同一完整候选，并独立重验连接及声明规则。当前是两层离线、焊盘包围盒代理；非零起点矩形板及委托地平面明确不在该桥接支持范围。
6. 显式应用前重验输入/代码/候选指纹及项目规则；调用原 apply → verify → save → verify-after-save。范围外原问题保留不代表整板合格；原生完整预检未通过时候选仍停在离线。
7. 已应用但已知保存失败时，恢复使用原不可变回执、同一候选/快照/配置及其绑定的路由证据，只调用原 verify → save → verify，不重放 apply 或重新求路由。未知结果、并发保存和已保存仍阻断续存。已保存但回读失败使用 verify 阶段，只读复核原计划与当前现场，不再次保存。

## 应用回执与复用

首次应用前独立核验路由回执，将它保留在应用目录的 `fine-routing-receipt.json`；原不可变 apply 回执的 `acceptanceEvidence` 绑定输入、请求、候选、实现与路由证据的哈希和引用。续存和复核自动读取该证据，不复制第二份，不改变路由铜的离线状态。证据缺失、修改、候选或规则变化时停止，不能用另传对象替换已绑定证据。

`--resume-save` 和 `--receipt` 接受 `application.json`、原生执行报告或原 apply 回执。旧回执没有细布局证据关联时仍核对原计划／快照／配置；若要求试走线，另传 `--routing-receipt <原匹配路由回执>`，不改写旧回执或保存标记。实现版本变化仍需处理版本不符，不能把旧证据当作当前版本已经通过。

`verify` 只调用已有 `verifyLayout`，返回 `verification.json`。`state.saved` 的 true／false／null 来自原保存链证据，分别表示本链已确认保存、未保存或确定保存失败、保存结果未知；几何匹配不把 null 改为 true。`savePending/saveUnsettled` 表示原保存链占用或未决，与保存事实分别记录；复核不清理占用、不重写旧报告。该复核检查原生源指纹、目标、完整候选和实际对象，不代替磁盘工程验读、DRC 或实际铜验收。

## 输出与失败

报告包含 `inputs/request/problem/solver/result/manifest.json`、阶段状态与逐条关系。`scope.selection` 记录成员派生和排除原因；`problem.objectiveComposition` 与候选审计记录基础和本轮目标的合成结果。独立模式另有 `body-candidate.json`、`label-problem.json`、`label-solver.json`。只有完整候选才有 `candidate.json`；其源指纹、完整对象及保持证明用于后续交接。

模型无效、有限预算耗尽、编译模型不满足、器件拒绝、文字阶段失败及最终拒绝分别报告。文字失败保留器件证据，不自动缩字、不扩大范围、不写 PCB。有限搜索失败不等于工程空间无解。

## 验证记录

细布局、独立文字、已有完整计划接入、固定器件的独立位号权限、保存失败续存、只读复核，以及源／候选／路由证据变化、整批核验、等价角度、未决结果和并发保护由 Mock 回归覆盖。项目现场已完成完整独立文字候选接入、原生应用、保存、保存后 SDK 复核与磁盘设计记录对照；源变化拒绝及批准范围内重新接入也有现场证据。保存失败续存、未知结果及并发恢复等其他情形仍按 Mock 覆盖范围记录。代表核验何时重做按[共同触发条件](../0.3-easyeda-pro.md#代表核验)；这份记录不是每轮执行清单。

离线试走线及几何验收不代表实际铜、回流、均流、热或制造验收通过，也不代表整板完成。
