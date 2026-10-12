# 公共细布局执行接口

工程顺序与验收范围见 [3.5.2 细布局](../3.5.2-fine-layout.md)。唯一外入口是 `scripts/pcb-layout.mjs fine`，也接受 `--mode fine`；旧 `pcb-fine-layout.mjs` 仅转发同一内部入口。

## 输入与权限

使用公共 `prepare` 的冻结目录，或完整 `inputs.json`，不绕过器件身份、封装、焊盘归属、网络及支持条件核对。请求 `schemaVersion: 1`：

| 字段 | 实际含义 |
| --- | --- |
| `blockId`、`movableRefs` | 可选 Contract 块，以及本轮明确可动成员；不是刚性簇模板 |
| `allowedNeighborRefs` | 另外明确允许让位的器件；默认空，不按求解失败自动增加 |
| `fixedRefs`、`releaseFixedRefs` | 本轮固定成员；释放只允许有明确来源的 `hard.fixed`，不能释放原生或机械锁，也不移动锁定焊盘或文字的所属器件 |
| `region` | `mode`、`basis` 必填；`window` 指定 `boundsMil`，`available-space` 默认用真实板框内全部建模空间；`referenceBoundsMil` 仅记录借用比较范围 |
| `reservedRegions` | 有 ID、来源与边界的预留矩形；几何为 `physical`、`assembly` 或 `placement`；缺少装配视图时明确拒绝相应请求 |
| `relations` | 每条有 ID、依据、实际 `from/to` 焊盘及网络；端点用 `{ref,pin}` 或唯一 `{padId}`，独立测试焊盘只能作为固定上下文 |
| `labels` | 默认 `mode: separate`；兼容 `joint`。间距继承机械规则与既有模板，可明确给 `clearanceMil`、`maxOwnerDistanceMil`、`maxSeconds` |
| `baselinePolicy` | 默认 `require-clean`；显式 `retain-outside-issues` 允许保留未移动外部的同一问题，内部及新问题必须通过，仍分别报告整板资格 |
| `routing` | `required`、需检查的 `nets`、明确层/宽度 `policy` 与工具 `options`；未完成必需检查不能写回 |
| `objective.retainSource` | 默认保留源模型的软目标；请求关系可增加软权重，不自动把旧距离变硬上限 |

关系的 `weight` 是软目标，`maxDistanceMil` 是有来源的硬条件；`nonRegression.toleranceMil` 只有显式声明才采用。`critical: true` 而没有验收条件时标为未覆盖并阻断合格候选。距离为实际焊盘包围盒中心的曼哈顿代理，每条变化均报告，总分不抵消单项拒绝。

`available-space` 放宽的是工作窗口，实际板框、锁、固定器件与焊盘、外部文字、装配/操作包络、来源约束和预留仍保留。当前使用轴对齐包围盒，是保守搜索域，不保证枚举了所有物理可用空白；不移动已有铜，不自动让位邻居。

## 阶段与命令

```text
node <skill>/scripts/pcb-layout.mjs fine --stage solve --project-root <project> --prepared <frozen-report> --request <request.json> --output <project-relative-report> --python <existing-runtime> --seconds 25
node <skill>/scripts/pcb-layout.mjs fine --stage route --project-root <project> --from <solve-report> --output <route-report> --python <existing-runtime> --seconds 30
node <skill>/scripts/pcb-layout.mjs fine --stage apply --project-root <project> --from <solve-report> --window-id <confirmed-window> --output <application-report> --routing-receipt <route-report/fine-routing-receipt.json>
node <skill>/scripts/pcb-layout.mjs fine --stage resume-save --project-root <project> --from <solve-report> --window-id <confirmed-window> --resume-save <application.json或原apply回执> --output <recovery-report>
node <skill>/scripts/pcb-layout.mjs fine --stage verify --project-root <project> --from <solve-report> --window-id <confirmed-window> --receipt <application.json或原apply回执> --output <verification-report>
```

写回和恢复仅在对应授权及目标核对后使用。求解不读取 EDA、不自动写入。当前预算为器件最多占 80%，文字使用剩余时间；每阶段与总墙钟耗时单列，进程启动及证据 I/O 是可观察开销。

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

报告包含 `inputs/request/problem/solver/result/manifest.json`、阶段状态与逐条关系。独立模式另有 `body-candidate.json`、`label-problem.json`、`label-solver.json`。只有完整候选才有 `candidate.json`；其源指纹、完整对象及保持证明用于后续交接。

模型无效、有限预算耗尽、编译模型不满足、器件拒绝、文字阶段失败及最终拒绝分别报告。文字失败保留器件证据，不自动缩字、不扩大范围、不写 PCB。有限搜索失败不等于工程空间无解。

## 验证记录

细布局、独立文字、保存失败续存、已保存后的只读复核，以及源／候选／路由证据变化、整批核验、等价角度、未决结果和并发保护由 Mock 回归覆盖。真实 SDK 文字渲染和边界框对照尚未现场实测。代表核验何时重做按[共同触发条件](../0.3-easyeda-pro.md#代表核验)；这份记录不是每轮执行清单。

离线试走线及几何验收不代表实际铜、回流、均流、热或制造验收通过，也不代表整板完成。
