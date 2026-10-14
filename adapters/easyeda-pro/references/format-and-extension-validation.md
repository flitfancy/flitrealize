# 格式与扩展验证说明

2026-10-13 在独立空工程、独立可见窗口验证；客户端 `4.1.71.7a7261be`，本次 API corpus 为官方 `1.1.44`（2026-10-09）。下面只描述代表对象和已取得的结果，不推断整套旧资料或其它客户端版本均适用。项目、窗口、文档绑定、保存与恢复仍按 [共同执行规则](../../../docs/0.3-easyeda-pro.md)。

## 当前格式入口

先查目标客户端的定义，再和公共 API 回读、保存后的实际文件核对：

```text
<客户端CLI> doc format
<客户端CLI> doc format --class-name TWire
<客户端CLI> doc format --class-name TSchLine
<客户端CLI> doc format --class-name TSchAttr
<客户端CLI> doc format --class-name TPcbVia
```

`doc format` 是当前客户端的格式定义；`scripts/api-reference.mjs` 查询的是固定 API 文档快照，两者不互相代替。定义可查询也不证明读写行为已通过。

| 代表对象 | 4.1.71 实测 | 旧资料不能直接套用的部分 |
| --- | --- | --- |
| 原理图导线 | 公共入口创建、按ID回读并保存一条L形导线；源码为 WIRE 组、带 lineGroup 的两条 LINE、带 parentId 的 NET ATTR | 旧 WIRE.dots 结构；数值线型与当前 SHORT_DASH；属性 positionX/positionY 与当前 x/y |
| 原理图坐标 | API返回正Y坐标，原生源码同一对象的Y为负；文件/源码/API须分别核对坐标约定 | 不把看到的坐标直接搬到另一表示；当前 TSchLine/TYAxisDirection 定义按来源说明方向 |
| 普通过孔 | 指定网络，200/300mil位置、20mil孔径、40mil外径，API与保存后文件匹配 | 旧 viaType 数字与当前 NORMAL；旧 locked 数字与当前boolean。PAD、盲埋孔和特殊垫形未验证 |
| PCB图层/板框 | 当前层记录用键式ID、载荷layerId和use/show/locked；公共板框入口的闭合折线写入、保存回读成功 | 不使用旧数字外壳ID和status位码解析当前层记录 |

源码规范化与指纹复用已有操作的实现，不从历史例子新建通用删除头部规则。格式概念可辅助诊断，旧约1.1.22的示例不能当作当前序列化规范。本次原理图保存已确认，但最小悬空线产生 SHOWFLOATING warning；没有将代表保存/回读当作电气或整板DRC通过。

## 扩展调用环境

实例调用使用 `eda.sys_I18n`、`eda.sys_IFrame` 等当前命名。精确参数、返回、版本和环境限制继续用当前 CLI `doc api --class-name … --method-name …` 或固定 corpus 的 `show` 查询。

- 当前语言读取和缺失标签回退已实测成功；没有验证打包的locale文件或新增多语言namespace。
- IFrame 的 open/存在性接口实际存在，存在性查询返回false；调用未打包的HTML路径明确失败。HTML需属于可用扩展包资源；这次没有安装扩展，因此不宣称有效资源窗口已显示。
- CLI command space、独立脚本与已安装扩展包的上下文不同；“接口存在”不提供资源、安装或外部交互权限。当前定义说明独立脚本的IFrame限制，不能把本次CLI结果外推到所有运行环境。
- 独立项目状态面板继续使用既有 View State。只有明确需要EDA内嵌扩展时，才准备资源包并重新验证，不以这些说明为安装或权限修改的授权。

本次渲染图像接口返回1×1空图，未取得有效截图；其它图形、层次结构、制造、设备/固件和订单行为未验证。
