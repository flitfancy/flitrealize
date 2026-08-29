> 本文件是英文参考文件 [easyeda-pro.md](../../../references/easyeda-pro.md) 的中文只读镜像，供人工阅读和审阅。实际执行仍以英文源文件为准。
> 同步日期：2026-08-29（Asia/Shanghai）
> 英文源文件 SHA-256：`E6D919FACEFFF46989CE44B8450AF1DC93B1090E55C8EC7B9C86252E13F88A62`

# EasyEDA Pro Provider 边界

处理 EasyEDA 对象身份、源文件/capture 证据、官方 API 选择和 Provider 专属事实边界时读取本参考。它是索引，不是所有 EasyEDA 任务都必须加载的完整操作手册。

直接加载与当前操作匹配的流程：

- 本机 Adapter、Bridge、握手、重连或配对：[environment.md](providers/easyeda-pro/environment.md)
- PCB 层结构、器件几何、功能性 keepout 或实际参考铜：[pcb-foundation.md](providers/easyeda-pro/pcb-foundation.md)
- 必要接地过孔、换层回流或全局缝合：[pcb-grounding.md](providers/easyeda-pro/pcb-grounding.md)
- 原理图器件放置、导线、网络标识和 DRC：[schematic-workflow.md](providers/easyeda-pro/schematic-workflow.md)
- 跨 Provider Action 契约与 Host/EDA Runtime 边界：[local-actions.md](local-actions.md)
- DRC 解释和制造输出验收：[pcb-review.md](pcb-review.md)

单次操作不要加载全部 Provider 流程。

## 把事实与同一个源版本配对

- 把已识别的 `.epro2` 副本作为下单候选的已保存源归档。
- 元件、焊盘、网络、层、规则和几何事实使用已保存源或结构化实时 capture；画布外观只能作为辅助证据。
- 用哈希、配置身份、时间戳和有用对象计数把导出与源配对。批准输出归档到项目根目录，不覆盖已评审基线。

## 扩展前探测陌生行为

先读当前官方 API 文档，再运行最小只读真实对象探针。验证会影响操作的区别：

- 器件、符号、封装、采购器件和项目实例；
- 符号引脚与铜焊盘、EP/独立焊盘、孔、槽、过孔、图形和元件本体；
- 坐标、旋转、单位、层、回读类型、异步行为和 BOM/PCB 标志。

使用精确 ID 或唯一精确名称，不接受模糊搜索第一项。移动或旋转前，从真实几何证明归属、预期计数和语义方向。存在未知已布铜或成员对象时，先确认变更闭包再进行大范围移动。

## 把注册 Action 作为执行接口

`scripts/actions/manifest.json` 是机器可读目录，拥有契约版本、领域、Runtime、已测试 Provider、模式、修改类别和预期能力等实现事实。本参考只解释 EasyEDA 证据应该如何理解。

```text
node scripts/action-runner.mjs list
node scripts/action-runner.mjs run --action eda-capabilities
```

方法存在只是 preflight 证据，不代表它对每个对象都能成功。写入模式仍必须满足 `SKILL.md` 的实时 EDA 锁、明确授权、精确 dry-run/apply 请求、回读以及可恢复失败路径。直接调用 `eda-host.mjs execute` 是开发或诊断逃生口，不是首选复用接口。

## 优先使用能增强证据的 API

优先选择能增强事实或消除重复手工工作的 API：

- 按网络查询图元、网络长度和网表回读；
- DRC 规则、差分对、等长组和焊盘对组；
- 画布计算状态，用有边界等待替代固定延时；
- Gerber、IPC-D-356A、BOM、贴片坐标、测试点和 PDF 输出；
- 文档事件，用于使缓存方案失效；
- 板框和图元包围盒查询。

把可用方法视为待探测能力，不视为使用授权。自动布线、自动布局、清除布线、整体替换规则、直接替换源码和下单/付款不进入普通可复用 Action，除非用户授权独立且可恢复的流程。官方 API 仍是 Beta，当前文档、实时能力探测和回读缺一不可。

## 收窄 Provider 结论

- PASS 必须引用原始回读，不能来自意图或生成计划。
- 静默、未解决 Promise 或超时都是失败。
- 手工修改引脚、封装、布局、布线、板框或 keepout 后，冲突的缓存方案立即过期。
- 项目专属网络、坐标和验收值放在项目配置或请求中，不复制到 helper 核心。
- helper 的限制只能证明 helper 行为，不能冒充未有文档的 EasyEDA 平台限制。

官方文档、已验证本地 Bridge、控制台脚本和第三方助手都是传输通道，不是证据权威。所有通道使用同一身份、授权、事务和回读契约。
