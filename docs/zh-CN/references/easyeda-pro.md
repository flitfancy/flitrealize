> 本文件是英文参考文件 [easyeda-pro.md](../../../references/easyeda-pro.md) 的中文只读镜像，供人工阅读和审阅。实际执行仍以英文源文件为准。
> 同步日期：2026-08-26（Asia/Shanghai）
> 英文源文件 SHA-256：`9EEEC472431F1E59A595DF1C55747A661489FE18EDB2AF16B910710D72377966`

# EasyEDA Pro 源文件、capture 与自动化

处理 EasyEDA 对象身份、实时 capture、Bridge/控制台自动化或版本匹配导出时读取本参考。

## 把事实与同一个源版本配对

- 把已识别的 `.epro2` 副本作为下单候选的已保存源归档。
- 元件、焊盘、网络、层、规则和几何事实使用已保存源或结构化实时 capture；画布外观只能作为辅助证据。
- 用哈希、配置身份、时间戳和有用对象计数把导出与源配对。批准输出归档到项目根目录，不覆盖已评审基线。

## 扩展前探测陌生行为

先读当前官方 API 文档，再运行最小只读真实对象探针。验证会影响操作的身份与区别：

- 器件、符号、封装、采购器件和项目实例；
- 符号引脚与铜焊盘、EP/独立焊盘、孔、槽、过孔、图形和元件本体；
- 坐标、旋转、单位、层、回读类型、异步行为和 BOM/PCB 标志。

使用精确 ID 或唯一精确名称，不接受模糊搜索第一项。移动或旋转前，从真实几何证明归属、预期计数和语义方向。未知已布铜或成员对象存在时，先确认变更闭包再进行大范围移动。

## 把每次实时写入做成可恢复事务

先满足 `SKILL.md` 的完整实时 EDA 锁定，再让一个决策核心完成：

1. **Preflight：**精确项目、PCB/文档、目标 ID/计数、入口状态、通道可用性、过期/禁止制品和受影响对象上限。
2. **Snapshot：**完整变更闭包，以及检测旁路变化和恢复状态所需的全局不变量。
3. **Apply：**只执行授权增量，异步行为有边界，并能观察开始和最终状态。
4. **Readback：**把归一化身份、成员关系、几何、计数和操作专用不变量与预期后状态比较。
5. **Rollback：**部分成功、超时、不匹配或异常时恢复捕获闭包并验证。无法完整回滚时停止并展示精确可恢复状态。

选择局部修复或回滚前先读取完成状态，不盲目重跑完整 apply。改变拓扑时还要把操作后网表与 `操作前状态 + 授权增量` 比较，未受影响连通性必须不变。

### 使用注册式 Action 协议

把 `scripts/actions/manifest.json` 作为机器可读的 Action 清单。它声明每个 Action 的契约版本、领域、Runtime、已测试 Provider、支持的模式、是否修改文档，以及预期 API 能力。修改这套跨 Runtime 契约时读取 [local-actions.md](local-actions.md)。对于 EDA Action，不读取 Action 源码即可列出当前接口：

```text
node scripts/action-runner.mjs list
```

重复工作优先使用统一 Runner，让输入与可执行代码分离、成功输出保持紧凑，并把完整 Bridge 响应保存在主机本地报告中：

```text
node scripts/action-runner.mjs run --action eda-capabilities
```

只读 `eda-capabilities` Action 会对当前 EasyEDA API 表面的方法存在性生成指纹。方法存在只是 preflight 证据，不代表它对每个对象都一定执行成功。注册为写入的模式如果没有 `--allow-write` 会被拒绝；该开关只记录所选执行路径，不能替代 `SKILL.md` 规定的实时写入授权和事务锁。只有完整响应确实需要进入调用进程时才使用 `--full`；其他时候仅在具体失败或精确几何需要时读取本地报告。直接调用 `eda-host.mjs execute` 仍作为开发或诊断 Action 的底层逃生口。

### 根据计划建立铜层

把建层当成由设计支撑的事务，不把它简化成固定四层模板。计划应声明精确文档、铜层数量、每层有序角色、内层名称与类型、预期参考/平面网络，以及物理层叠或阻抗目标的来源。先捕获当前层列表和物理层叠；减少层数可能移除已有内层内容，必须作为独立的破坏性评审处理。

可移植动作 `scripts/actions/pcb-layer-stack.js` 可通过已注册主机 Adapter 检查、应用、验证并立即回滚层结构。动作数据单独传入，不嵌入 helper 源码：

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-layer-stack.js --input-file <action.json>
```

写入层角色或平面网络名称不等于已经存在铜。正片信号层仍要在遵守板框和 keepout 的前提下创建并重建目标铺铜；内电层要验证分区和网络；最后单独回读实际铜。物理层叠数值仍由具体项目和板厂拥有，本动作不会覆写。

### 铺铜前保护功能性禁铜区域

不要只靠板级 Region 查询推断全部铜限制。先用 `scripts/actions/pcb-component-geometry.js` 检查精确的实时器件和封装几何，包括焊盘、槽、文档源码上下文和图元包围盒。按工程目的分类每项限制：天线净空、声学开孔、裸露焊盘散热区、电气隔离、安装/机械净空或厂商规定的 keepout。封装庭院层或丝印外框不自动等于铜 keepout。

使用 `scripts/actions/pcb-functional-keepouts.js` 规划、应用、验证或回滚数量受限且精确的板级 Region。方案声明几何、层、规则类型、来源和受保护几何指纹。Apply 会回读每个新增对象的 ID，并返回只含这些 ID 的回滚请求；它不会保存或重铺铜。如果当前 API 不回传 Region 名称，或把显示线宽归一化，验证改用精确 ID、几何、层、规则、锁定状态和受保护不变量，而不依赖这些外观字段。

### 分三个阶段闭合接地

把接地作为一个完整闭环：入口先做只读盘点，出口使用统一验证门：

1. **建立实际参考铜。**解析层叠、板框、功能性 keepout、目标平面网络和生成的铺铜填充。
2. **闭合必要回流。**添加最小且有依据的器件、去耦、散热、ESD 过孔，以及信号换层参考地过孔。缺少必要回流时保持 blocker 或明确未决证据。
3. **优化全局缝合。**只有布局、布线、keepout 和前两个阶段稳定后，才按需规划稀疏区缝合、板边围栏和其他全板回流优化；过孔更多不构成验收标准。

任何写入后都要在相关层重铺铜、运行已配置 DRC、回读精确新增图元、目检目标区域，并把钻孔输出与接受的源版本配对。任一手工编辑都会使对应阶段的缓存方案失效。

### 创建并验证实际铜皮

只有板框和功能性 keepout 已解析后，才使用 `scripts/actions/pcb-ground-pours.js`。它支持 inspect、plan、apply、verify 和定向 rollback。动作提取精确闭合板框，捕获受保护的器件/走线/过孔不变量，每次只创建一个数量受限的铺铜，重建后同时回读铺铜边界和生成的 `Poured` 填充对象。它不会保存文档。

成功回读铺铜边界不代表铜皮已经生成，也不能证明 keepout 得到遵守。必须检查生成的填充路径，并针对每个已声明的关键 keepout 探针点验证它既不落入实际铜皮，又位于相应净空轮廓内。先在一层建立早期检查点，再扩展到其他层。多边形和包含关系 API 仍是 Beta，且已观察到版本相关行为，因此要做能力探测，并为受支持的板框图元保留经过测试的解析几何 fallback；无法支持的几何继续阻塞。

### 放置规划过孔前检查接地

使用 `scripts/actions/pcb-grounding-inspect.js` 作为只读盘点动作。它枚举 API 可见的全部覆铜、Region、过孔和器件；按网络与层汇总覆铜；报告指定器件附近的 GND 过孔；并同时扫描当前文档源码和文档中的封装源码。源码扫描会区分真正实例化的 keepout 记录与仅用于显示配置的 `PROHIBITEDREGION` token，避免把 API 查询范围缺口误判成“板上没有对象”。

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-grounding-inspect.js --input-file <inspect.json>
```

结果包含 `inspectionFingerprint`、API/源码覆盖情况、全部覆铜网络、API 可见 keepout 几何，以及尚未解析的封装 keepout 证据。该指纹还覆盖器件布局/焊盘摘要和去除纯 UI 记录后的文档/封装源码。把原始结果与过孔方案保存在一起；此后手工修改布局、布线、覆铜、Region、过孔或 keepout 源码都会使该指纹失效。
默认的 `detailLevel: summary` 仍会扫描全部对象，但让 Bridge 回传结果保持紧凑；只有在建立候选方案确实需要精确图元几何时才请求 `detailLevel: full`。

使用 `scripts/actions/pcb-ground-vias.js` 作为独立的生成与事务动作。`mode: generate` 会解析精确位号和 GND 焊盘号，读取实时焊盘坐标与外形，并按四个正交方向生成数量受限的候选过孔。它会选择能够避开已解析板级 keepout 和已有/规划过孔的候选，但在板框内包含关系与局部铜皮/焊盘/走线间距得到独立证据前仍返回 blocker；无法解析的自定义焊盘外形如果没有已证明的 fallback 半径也会保持阻塞。
生成结果默认使用紧凑摘要；只有诊断被拒候选的具体几何时才请求 `detailLevel: full`。

也可以用 `mode: plan` 输入外部确定的、数量有上限的精确候选过孔列表。两种路径都要求精确文档身份、检查指纹、网络、孔径/外径、板框内包含证据和局部间距证据。dry-run 会检查状态是否过期、API/源码覆盖、与板级 keepout 的相交，以及与已有/规划过孔的碰撞。只有全部候选都可执行时才返回 `applyRequest`：

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-ground-vias.js --input-file <plan.json>
```

Apply 使用与 dry-run 完全一致的指纹，单次最多创建 200 个过孔，逐个回读，并确认原有过孔没有丢失，同时返回只针对本次新增对象的回滚请求。它不会保存或重铺铜。如果文档或封装源码存在 keepout，但 API 无法把它解析成板上几何，Apply 会阻止写入而不是绕过。T1 阶段新增过孔仍要经过后续 DRC、必要时的重铺铜/回读和目视检查才能接受。

使用 `scripts/actions/pcb-ground-stitching.js` 作为全局优化阶段以及信号换层回流候选的独立只读规划器。它当前要求声明已经生成实际铜皮的正片 GND 铺铜层，解析板框与阻断 Region，盘点焊盘、走线、圆弧和过孔，并支持数量受限的 `plane-grid`、`edge-fence` 和 `signal-transition-return` 策略。它绝不创建过孔。规划器会给候选评分和过滤，为每个入选位置记录原因与锚点，再输出交给现有 `pcb-ground-vias.js` 事务动作的方案：

对于 `edge-fence`，规划器先参数化完整累计周长，生成有上限的更密候选集（默认每个目标间距取四个采样），再执行全部硬几何过滤。靠近板边的已有 GND 过孔会作为等周长分桶的覆盖种子；新候选先填补未覆盖分桶，随后以确定性的最远点步骤补位，并且只有确实缩小“已有＋新增”最大环形周长空档时才继续添加。结果会分别报告已有/新增分桶覆盖以及补孔前后的最大空档；`maxCount` 是上限，不是必须填满的目标。

```text
node scripts/eda-host.mjs execute --eda easyeda-pro \
  --code-file scripts/actions/pcb-ground-stitching.js --input-file <generation.json>
```

不得把它的输出直接交给 apply。先把返回的 `nextRequest` 送入 `pcb-ground-vias.js` 的 `mode: plan`；第二次 dry-run 会重新检查接地盘点指纹、源码/API keepout 覆盖以及规划/已有过孔碰撞，只有通过后才会产生 apply 请求。当前板边围栏对非凸板框保持阻塞；无法支持的板框、Region、焊盘或圆弧几何应继续解析证据，不能作为绕过间距检查的理由。内电层 Region 还需要独立的源码证据，本规划器才能把它视为已完成的第一阶段地结构。

只读诊断不保存、重铺铜、切换持久规则或修改文档。删除、大范围导入、自动布线、重铺铜、替换封装或批量规则修改需要可恢复源检查点。

## 优先利用高价值官方 API

优先选择能增强证据或消除重复手工操作的 API 类别：

- 按网络查询图元、网络长度和网表回读，用于连通性与长度审计；
- DRC 规则、差分对、等长组和焊盘对组，用于设计支撑的约束与语义验证；
- 画布计算状态，用有边界的等待替代固定延时；
- Gerber、IPC-D-356A、BOM、贴片坐标、测试点、PDF 等制造输出，用于与源版本匹配的发布证据；
- 文档事件，用于手工编辑后让缓存方案失效；
- 板框和图元包围盒查询，用于基于真实几何的规划。

把每个可用方法视为需要探测的能力，不视为使用授权。自动布线、自动布局、清除布线、整体替换规则、直接替换文档源码以及下单/付款操作，不进入普通可复用动作；除非用户明确授权一个独立且可恢复的流程。部分制造方法只在特定部署可用。官方 API 仍是 Beta，因此当前文档、实时能力探测和回读验证缺一不可。

## 保持脚本可观察且不过期

- 用户操作的脚本以文件交付，并注明活动文档、预期可见结果和停止条件。
- 对可选 UI 反馈做特性检测，并始终输出机器可读控制台/报告结果；静默、未解决 Promise 或超时都是失败。
- PASS 引用原始回读，不来自意图或生成计划。
- 手工修改引脚、封装、布局、布线、板框或 keepout 后，先 capture 并对账拥有该事实的契约，再复用 apply 脚本。
- 每个动作只保留一个当前 diagnose、apply、verify 和针对性 regression 入口。项目网络、坐标和验收值放在配置/adapter 中，不复制 helper 核心。

## 复用一个主机 Adapter，避免反复探测

Bridge 传输/服务端放在可移植核心 Skill 之外。在机器配置中注册一次本地安装位置，之后由 helper 启动或复用；可移植动作文件仍只通过该 Adapter 执行：

```text
node scripts/eda-host.mjs register --eda easyeda-pro --adapter-root <adapter-root>
node scripts/eda-host.mjs ensure --eda easyeda-pro --require-eda
```

主机配置可以包含本机路径；项目状态和公开 Skill 不得包含本机路径。项目可以在 `.flitrealize/project.json` 中声明预期 EDA 和文档。声明的 EDA 与实际连接不一致时，在任何实时操作前按身份硬失败处理。

每个 agent 会话第一次实时访问 EDA 前运行轻量鉴权握手，而不是每轮聊天都检查。只有 Bridge session ID、Adapter/EDA 身份、选定窗口和目标文档都不变时才复用结果。断线、EDA 重启、窗口/文档切换、Adapter/API 版本变化、能力调用失败或项目不匹配后重新探测。

如果 Bridge 启动时 EasyEDA 网关已经用完重试次数，helper 会返回 `EDA_NOT_CONNECTED`。在 EasyEDA 中执行一次 **API Gateway -> 重新连接**；以后先启动 Bridge 再打开 EasyEDA，就不需要这一步恢复。

使用 helper，不直接调用未鉴权 HTTP。每次会话的令牌由本地 Adapter 保管，不进入提示词，只返回紧凑的结构化状态。任意代码执行只是开发传输通道，不等于授权或证明；所有实时写入仍须满足上面的事务和回读契约。

把 Agent 鉴权和 EDA 网关配对视为两个不同结论。如果已安装网关不能提供配对凭据，就把该通道归类为本地开发模式，而不是“EDA 已通过密码学认证”。此时必须只监听 localhost，通过只读探针确认真实项目/文档，不得把这种模式当作共享主机或敌对主机上的安全边界。

## 平台方法不放进治理参考

当宿主或项目提供可复用网络类 helper、色板或 adapter 记录时，只把它经过测试的行为视为实现证据。helper 限制不得冒充未有文档的 EasyEDA 平台限制。其他易漂移 API 事实和已证实陷阱，在存在已配置知识 catalog 时放入其中，否则保存在项目本地证据中。

官方文档、已验证本地 Bridge、控制台脚本和第三方助手都是传输通道，不是证据权威。所有通道使用同一身份、授权、事务和回读契约。

DRC 解释、Gerber/钻孔和板厂预览检查读取 [pcb-review.md](pcb-review.md)，不在这里重复制造指导。
