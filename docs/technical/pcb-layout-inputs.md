# PCB 布局输入与求解参考

准备阶段的工作顺序与输入归属见 [3.3](../3.3-pcb-layout-inputs.md)。本页保存求解命令、后端限制和运行示例；公共字段与语义统一见[布局数据约定](../../schemas/pcb-layout.md)。准备数据或选择后端时读取相应小节；实际原生读取、移动与写回见 [3.5 布局与空间](../providers/easyeda-pro/3.5-pcb-placement.md)。

功能块布局的工作内容见[功能块布局](../3.5.1-block-layout.md#二做什么)，当前实现与支持范围见[执行说明](../3.5.1-block-layout.md#执行说明)。本页引用已有数据约定并维护真实入口，不因阶段交接就增加未实现的配置键。

## 输入从哪里来

| 来源 | 提供的内容 | 谁来维护 |
| --- | --- | --- |
| 电路设计稿 | 器件身份、逻辑引脚、网络、功能块、电气意图 | 复用上游设计 |
| 当前 PCB | 对象 ID、归属、位置、角度、层、锁定、焊盘与位号几何 | 软件适配层读取 |
| 项目布局配置 | 固定条件、接口方向、装配间距、操作空间和关联要求 | 按工程依据填写 |
| 搜索配置 | 起点、种子、预算、权重、候选数量 | 按本次目标调整 |

AI 补充工程意图和缺项；脚本读取已有数据、转换单位、关联对象并计算几何。当前坐标和网表不需要手工再抄一份。

### 基础规则与本轮变化

基础与本轮规则的继承、替换、追加和距离口径见[布局数据约定](../../schemas/pcb-layout.md#基础规则与本轮变化)。

## 项目需要提供什么

器件、功能块、整板、机械与搜索配置，电气关系及文件引用统一见[布局数据约定](../../schemas/pcb-layout.md#项目布局配置)。

## 脚本自动取得和检查什么

软件适配层读取位置、旋转、层、锁定、封装、焊盘与位号几何、对象归属和原生网表，转换为统一坐标与层用途。字段见[布局标准化与原生观察](../../schemas/pcb-layout.md#布局标准化与原生观察)。

脚本关联电路设计稿与实际对象，核对引脚网络、编译规则，并计算物理边界、邻接关系和评分尺度。`constraints` 的文字要求进入覆盖清单，自动编译使用 `extensions.pcbLayout` 的明确关系；要求原有的 `evidenceState` 与本次布局覆盖、几何检查分别记录。

| 情况 | 处理 |
| --- | --- |
| 纳入 PCB 的器件缺失，或存在未声明对象 | 报告身份不一致 |
| `includeInPcb: false` | 从布局输入副本排除；若仍存在于 PCB，则报告冲突 |
| 归属、网络、固定条件或规则互相矛盾 | 返回具体错误，停止求解 |
| 缺少已声明规则所需的几何或参数 | 返回缺项，不补猜测值 |
| 未提供可选规则 | 不产生对应约束 |
| 可选原生观察不可用 | 保留未覆盖状态，继续检查其他可用数据 |
| 当前位置违反可修复的间距或贴边条件 | 作为布局问题报告，与输入错误分开 |

prepare 的输出文件与覆盖语义见[准备输出约定](../../schemas/pcb-layout.md#准备回执与冻结输入)。

## 布局求解入口与后端

下面的命令与模式按实际支持范围使用。数值运行依赖按需见[首跑指南](../../first-run.md#数值与路由环境)。

CP-SAT 语义后端支持可选的[功能块布局软评分](../../schemas/pcb-layout.md#功能块布局软评分)，配置字段与计分语义见该数据约定。

功能块布局只需器件占位时，可用共享 `scopeLayoutModel()` 保留板框并声明 `includeLabels:false`，再让语义求解的 `compileSemanticCpSatProblem()` / `runCpsatLayout()` 使用同一选项；新指定位置通过 `contextPlacements` 进入范围模型，已有原生锁仍保留。此类候选注明位号未纳入求解，不能直接作为完整原生写入计划；写回前补齐并验收完整器件、位号和焊盘计划。

```text
node <skill>/scripts/pcb-layout.mjs --project-root <项目> --mode semantic --prepared <prepare目录>
node <skill>/scripts/pcb-layout.mjs --project-root <项目> --mode solve --backend cpsat --prepared <prepare目录> --candidates 3 --seconds 30 --python <解释器>
node <skill>/scripts/pcb-block-layout.mjs --project-root <项目> --input <请求JSON> --mode open|pack|verify|channels --python <解释器>
```

CP-SAT 与原搜索后端共用 `prepareLayoutInputs`、位号模板、`validatePlan` 和报告。选定完整候选沿用 `pcb-layout.mjs --mode apply`，现场和实现指纹变化后重新准备。块内/带铜块结果不是完整原生写入计划，不直接套用 apply。

实现指纹从布局入口追踪相对导入、求解 Worker/Python、准备与验收代码、原生阶段片段及宿主通道依赖。独立布线实现和纯 HTML 展示模块不使布局候选失效；布局复用的铜几何仍参与指纹。格式约定的标题、说明、注释和示例不参与指纹，字段、约束与默认值仍参与；代码文件继续按内容核对。外部注册适配器、EDA 可执行文件和已安装 Python 环境不属于随包实现指纹，现场身份、基线和运行结果仍按原执行流程核对。

独立布局入口可调用 `layoutEngineIdentity({entrypoints:[skill根内的相对入口]})`，在公共依赖上增加自己的导入闭包；测试可另传 `skillRoot`。新非字面动态资源必须在 `pcb-layout-engine.mjs` 声明并补失效对照测试，不能靠目录扫描猜测。


### 最小运行示例

随包 [两器件样例项目](../../assets/pcb-layout/minimal-project/design/PCB_LAYOUT_CONSTRAINTS.v1.json) 和 [open 请求](../../assets/pcb-layout/block-open-request.json) 可用于首次试运行。先将 `assets/pcb-layout/minimal-project/` 复制到独立 `<EXAMPLE_PROJECT>`；真实项目继续使用自己的输入，不写回样例。

```text
node "<skill>/scripts/pcb-layout.mjs" --project-root "<EXAMPLE_PROJECT>" --mode prepare --snapshot "<EXAMPLE_PROJECT>/snapshot.json"
node "<skill>/scripts/pcb-block-layout.mjs" --project-root "<EXAMPLE_PROJECT>" --input "<skill>/assets/pcb-layout/block-open-request.json" --prepared "<上一条返回的report目录>" --mode open --output evidence/open-example --python "<数值环境的python>"
```

prepare 返回报告目录；它没有 `--output` 参数。block 的 `--prepared` 接受该目录或其中 `inputs.json`，与请求内嵌 `bundle` 二选一，无需复制大JSON。样例为离线教学数据，不能作为实际PCB的apply来源。

开放块的小请求字段见[数据约定](../../schemas/pcb-layout.md#开放块请求字段)。

### 语义与冷启动

`pcb-layout-semantic.mjs` 从已声明的局部关系、分组、网络和功能块派生柔性子组，保存关系来源与未归属项。角色文字推断默认关闭；如项目要使用，以 `--semantic-policy <项目JSON>` 明确 `roles`、关联权重及停用词，不将某项目器件名写入模块。

分组范围与来源保留规则见[语义分组约定](../../schemas/pcb-layout.md#语义分组策略)。

求解需要器件几何、固定条件和规则输入，无需初始布局种子。默认直接在完整合法位置与朝向域中求解，不读取旧位置提示，也不施加旧布局移动偏好。CLI 不接受 `--initial-plan` 作为 CP-SAT 提示。

`--seconds` 是每轮求解的求解器预算，`--starts` 限制运行次数；完整模型已证明 `INFEASIBLE` 时停止换种子。没有候选时，`noCandidateReason` 区分 `infeasible`（完整模型已证无解）、`budget-exhausted`（预算内尚未找到解）、`validation-rejected`（生成后精确验收拒绝）和 `error`，每次实际状态保存在 runs 产物中。

OPTIMAL 表示当前量化目标与约束下的最优解。

### 开放功能块

open 请求与锁权限见[开放块约定](../../schemas/pcb-layout.md#开放块请求)。

开放输入由共享 `scopeLayoutModel()` 保留范围、身份和锁来源，再以 `placementMode: 'open'` 明确编译。板框字段保持空，`computationalCoordinateMil` 仅描述计算搜索域；不把它变成机械板框。

通过的局部候选再生成刚性模板；必须核对模板所有器件唯一归属及外部端口，局部多端点连接不等于跨块完整网络完成。

### 带铜模板装入与冲突反馈

输入、模板字段、铜规则与 transforms 见[模板请求约定](../../schemas/pcb-layout.md#带铜模板请求)。

`createRigidBlockAtlas(model,groups,{refs,copperRules,...})` 返回 `{atlas,model}`。它从共享 scope 派生实际板框、固定姿态、许可旋转、装配间距、贴边和显式分离规则；网络权重与排除网默认沿用公共 model。模板作为后端表示，不维护第二套布局规则。焊盘及焊盘铜由公共model按组内位姿重派生；声明的ID、归属、网络或几何矛盾时拒绝，派生后遗漏也不能通过公共验收。

由公共 model 派生的 atlas 标记 `publicValidationRequired:true`。pack/verify 必须绑定对应公共 model，再由 `validateRigidBlockPublicModel()` 重建候选并调用原 `validatePlan()`；装配/操作空间、引脚距离、块锚点和空间约束以该验收为准。保存后的派生 atlas 再验证时，同时提供对应 `bundle`，不能只凭 atlas 的几何结果宣称公共规则通过。位号仍明确在本研究范围之外。

旧的独立 `{atlas,settings,options}` 保留为 legacy 离线几何诊断，verify 可另给 transforms；报告保留 `LEGACY_EXPLICIT_RIGID_ATLAS`，不会把调用者手填规则或原生层号当作已派生、已验证的公共布局合同。

CP-SAT 装入后独立检查几何、异网铜、显式禁布与引出空间，把精确冲突变成 `cuts` 回求；最终公共验收失败仍拒绝候选。`channels` 用输入铜通道做 FFT 快筛，输出只供搜索剪枝，之后继续绑定公共 model 精确验证。保留局部模板的地/载流/制造未验证状态，完整原生写入仍沿原执行流程另行生成并验收。

### 范围

当前迁入的是正交几何和刚性模板；它不实现全局协商拥塞、LNS/RUDY或任意柔性形变。模板支持覆盖范围由传入数据和验收报告决定，完整位号、独立测试焊盘、机械操作空间及原生 DRC 仍由现有完整执行流程检查。未知几何不静默降成无约束。
