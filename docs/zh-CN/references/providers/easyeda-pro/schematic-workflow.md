> 本文件是英文参考文件 [schematic-workflow.md](../../../../../references/providers/easyeda-pro/schematic-workflow.md) 的中文只读镜像，供人工阅读和审阅。实际执行仍以英文源文件为准。
> 同步日期：2026-08-29（Asia/Shanghai）
> 英文源文件 SHA-256：`9C7F24A26FA36AA95CCE77D0639F6A763B2E739A580FCAC5CB374774FED2C5B5`

# EasyEDA Pro 原理图工作流

在通过 Action 系统放置器件、绘制导线、添加网络标识或运行原理图 DRC 时读取本工作流。

## 输入

- `SCHEMATIC_CONTRACT.v1.json` 用于设计意图（器件角色、网络映射、引脚分配）；
- 从 contract 或库搜索解析出的 libraryUuid 和 deviceUuid；以及
- 已确认为 `easyeda-pro` 的当前原理图文档。

## 先放置器件

使用 `schematic-component-place` 的 `plan` 模式，传入器件数组，每个指定 `libraryUuid`、`uuid`、`x`、`y`。Action 会读回每个创建的图元并验证其存活。任何失败都会自动回滚所有新创建的器件。

```text
node scripts/action-runner.mjs run --action schematic-component-place \
  --input-file plan.json --allow-write --eda easyeda-pro --project-root <root>
```

plan JSON 格式：

```json
{
  "mode": "apply",
  "plan": {
    "expectedDocumentUuid": "<schematic-uuid>",
    "items": [
      {
        "libraryUuid": "<lib-uuid>",
        "uuid": "<device-uuid>",
        "x": 2000,
        "y": 3000,
        "rotation": 0,
        "mirror": false,
        "addIntoBom": true,
        "addIntoPcb": true
      }
    ]
  },
  "expectedPlanFingerprint": "<from-plan-dry-run>"
}
```

## 放置器件后添加网络标识和端口

使用 `schematic-net-flag` 的 `apply` 模式。支持两种类型：

- `netFlag`：电源/地符号，identification 为 `Power`、`Ground`、`AnalogGround` 或 `ProtectGround`。
- `netPort`：方向端口，direction 为 `IN`、`OUT` 或 `BI`。

两者都需要网络名称和坐标。创建的图元会返回 primitiveId 供后续验证。

## 最后绘制导线

使用 `schematic-wire-create` 的 `plan` 模式。每条导线需要 `net` 名称和 `points` 数组（至少 2 个 `{x, y}` 对）。Action 调用 `sch_PrimitiveWire.create()`，使用 EasyEDA 期望的 `[[x1,y1],[x2,y2],...]` 线段格式。

## 保存并验证

所有修改完成后，使用 `schematic-save-verify` 的 `verify` 模式保存文档并运行 `sch_Drc.check()`。从 Action 框架角度看这是只读的（保存是 EDA 侧操作，不是框架修改）。

## 能力要求

所有原理图 Action 在 manifest 中声明其所需的 API 方法。`eda-capabilities` Action 现在除了现有的 `pcb.*` 检查外还包含 `sch.*` 检查。在会话中首次运行原理图 Action 前先运行它以确认 API 可用。

## 过期与重新探测

原理图手动编辑后重新运行 `schematic-inspect`。当器件或导线被添加、删除或移动时，inspection 指纹会变化。过期的指纹会使待处理的 plan 或 rollback 请求失效。

## 常见陷阱

- `sch_PrimitiveComponent.create()` 的 `component` 参数接受 `ILIB_DeviceSearchItem` 或 `{libraryUuid, uuid}`。不要传裸字符串。
- 坐标单位是 EasyEDA 原理图单位（10 mil）。典型 A4 图纸约 15000 × 10000 单位。
- `createNetFlag` 创建的是器件（不是导线）。它出现在 `sch_PrimitiveComponent.getAll()` 中，不在导线列表中。
- `sch_Drc.check(strict, false, false)` 返回布尔值，不是错误列表。生产前检查使用 `strict: true`。
