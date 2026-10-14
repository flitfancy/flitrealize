# 项目记录与面板数据约定

本页集中可选交接 JSON、事实表区域和面板解析标记。文稿内容与更新归 [0.1](../docs/0.1-continuation.md)，工具调用归 [0.5](../docs/0.5-handoff-record.md)，面板启动及显示归[面板说明](../view-state/README.md)。

## 结构化交接记录

以下是字段示意，路径、时间、UUID 和哈希须用当前项目的真实值替换；不是可直接执行的样例，也不表示任何检查已经通过。尚未选择 EDA 或脚本时，`target` 或 `entrypoint` 写 `null`，不编造值。阶段名使用能明确当前工作的短名称，不是审批状态机。

````markdown
## 0. 当前交接

```flitrealize-handoff
{
  "schemaVersion": 1,
  "updatedAt": "<本次交接更新时间，带时区 ISO 时间>",
  "projectRoot": "<用户指定的绝对项目路径>",
  "stage": "pcb-layout",
  "objective": "收束布局，本次不布线",
  "target": {
    "provider": "easyeda-pro",
    "projectId": "<实际项目 UUID>",
    "documentId": "<实际 PCB UUID>"
  },
  "entrypoint": {
    "root": "project",
    "path": "design/placement-runner.mjs",
    "sha256": "<已选脚本的实际 SHA256>",
    "args": ["--input-file", "design/placement-input.json", "--plan"]
  },
  "nextAction": "先回读用户手改后的布局，核对受影响坐标并重建计划",
  "openItems": ["保存状态尚未确认"],
  "artifacts": [
    {"id": "source", "path": "design/board-source.json", "sha256": "<源文件实际 SHA256>"},
    {"id": "input", "path": "design/placement-input.json", "sha256": "<输入实际 SHA256>"},
    {"id": "readback", "path": "evidence/layout-readback.json", "sha256": "<回读证据实际 SHA256>"}
  ],
  "checks": [
    {
      "id": "placement",
      "status": "verified",
      "scope": "仅核对本批次 U1、C1 的目标坐标和原有对象保留",
      "checkedAt": "<该检查实际完成时间，带时区 ISO 时间>",
      "inputs": ["source", "input"],
      "evidence": ["readback"],
      "limitations": ["不包括保存、布线和整板 DRC"]
    },
    {
      "id": "save",
      "status": "unknown",
      "scope": "当前文档保存状态",
      "checkedAt": null,
      "inputs": ["source"],
      "evidence": [],
      "limitations": []
    }
  ]
}
```
````

- `entrypoint` 记录实际选中的脚本及调用参数，参数不含密钥或会话令牌；这里只是入口记录，不执行命令。引用的输入文件登记在 `artifacts` 中。多个步骤时记录当前下一步入口，其余编排以原脚本／工作流为准，不复制进状态。
- `artifacts` 只登记已有的项目内稳定文件，路径用 `/` 分隔。目录、URL、跨项目路径以及 `.flitrealize` 临时文件不能作为这里的证据。外部资料仍按原资料章节记录；需要指纹比对时使用已取得的项目本地制品。
- `checks` 每项有明确范围、所依据的输入版本和证据 ID。ID 唯一，且引用必须存在。记录工具实际检查的范围，不因工具返回 `ok: true` 把整阶段写成 `verified`。
- `updatedAt` 是交接更新时间；`checkedAt` 是检查发生时间，不随续接自动改成“现在”。未执行的检查填 `null`。
- `target` 是被记录的目标身份，不是现场探测结果。只读脚本不会证明远端文档、报告内部 UUID 或机器事实相符；仍由执行者核对。

## 自动事实表标记

初次采用时选择插入位置，放入以下空标记；脚本不自动创建文稿或追加区域：

```html
<!-- flitrealize:facts:start -->
<!-- flitrealize:facts:end -->
```

## 面板标记

### 当前阶段与摘要

需要显示当前阶段时，在二级“当前交接”标题下写一行 `当前阶段:`，值为主文稿已有的二级阶段标题，不含编号；尚未明确时写“待明确”。重复标记或找不到对应标题时提示检查，不推断其他阶段已完成。

`ViewState:` 使用英文冒号，独占一个物理行，后面直接写一小段摘要。每节最多一处，放在标题下、详细正文和下级标题之前，用空行分开。标记不放进列表、引用、代码块或自动事实表区域；这些区域不参与梗概导航。

通常写一至三句话，概括对应正文最值得知道的方案或结果，保留暂定、待验和覆盖范围。理解结论必需的参数或位号可以保留，长清单与日志留在正文。摘要里的新决定先落实到正文，不要求每段都有“下一步”。

```markdown
## 0. 当前交接

当前阶段: PCB 设计

ViewState: <本次工作焦点、主要结果或卡点>

## 3. PCB 设计

ViewState: <PCB 当前方案与已确认范围>
```

标题提供名称和层级，标记归属其所在章节，章节位置提供原文入口。缺少标记表示未提供梗概；重复标记不选取其中一段。查看端不自动摘取正文或从摘要推断验收状态。

### 网络表格

在“网络规则”标题下、下级标题前放置 `ViewStateTable: networks`，固定标记独占一行，紧跟三列表头，允许空行。每节最多一张表，每个网络一行。

```markdown
### 网络规则

ViewState: 线宽为规划值（主干 / 局部）；颜色为历史回读，当前板待复核。

ViewStateTable: networks

| 网络名称 | 线宽 (mil) | 颜色 |
| --- | --- | --- |
| SYS | 40 / 20 | #FF4040 |
| I2C_SCL | 6 | — |
```

以上只示意格式，不是默认参数或色表。线宽单位为 mil，可以写明确分段值；摘要说明表中值来自计划、实际回读还是历史结果。颜色填写有依据的 `#RRGGBB`，未知用 `—`；面板按色值画圆点，悬停显示 HEX，不补默认颜色或从散文猜行。

标记和表格不放进代码块、引用或自动事实表区域。网络名含 `|` 时用 `\|` 转义。也接受英文表头 `Network | Width (mil) | Color`。重复表格、重复网络、空表或无效色值提示格式错误。

## 面板健康返回

请求 `/api/health`；仅当 `service: "flitrealize-view-state"`、`schemaVersion:1`、`readOnly:true` 时复用。不同项目通过 URL 参数使用同一服务。
