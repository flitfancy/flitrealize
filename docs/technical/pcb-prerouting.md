# 离线试走线、铜路径与地空间工具参考

需要规划网络规则、试走线路、检查铜路径或诊断地空间时读取。本页说明现有工具的入口、模式、输出和必要限制；正式走线与交接见 [3.8](../3.8-prerouting.md)。

[3.7 预走线优化](../3.7-prerouting-optimization.md)中的引脚交换、器件旋转和出线空间调整，按各自实现说明执行，不直接对应本页的寻路模式。

运行依赖见[首跑指南](../../first-run.md#数值与路由环境)。

## 选择入口

- 网络分类、线宽与优先级规划：使用 pcb-routing-plan。
- 离线出口、路径、局部修复和地空间计算：使用 pcb-preroute.mjs。
- 实际自动布线及原生写回：使用 [EasyEDA Pro 分层自动布线](../providers/easyeda-pro/3.8-r-pcb-autorouting.md)中的 pcb-route.mjs。

前两项不需要连接 EDA，也不写入 EDA。通过能力清单查询现有入口，复用已有请求和脚本。

## 网络规则规划

规则来源和规划顺序见 [3.6](../3.6-pcb-routing-plan.md)，输入与输出字段见[网络规则数据约定](../../schemas/pcb-routing.md#网络规则规划输入)。

运行规划：

```text
node <skill>/scripts/action-runner.mjs run --action pcb-routing-plan --project-root <项目> --input-file <布线配置.json> --report-file <项目内规划报告.json> --full
```

规划成功后，按[派生请求的读取位置](../../schemas/pcb-routing.md#派生配色请求的读取位置)取得配色输入。需要实际设置颜色时，再调用：

```text
node <skill>/scripts/pcb-edit.mjs --project-root <项目> --action pcb-net-color --window-id <窗口> --input-file <配色输入.json> --apply
```

线段角色、改宽与配色请求见[数据约定](../../schemas/pcb-routing.md#线段角色与派生请求)。执行前读取实际线段并核对网络类成员。

规划器不创建网络类、线路或铺铜。过孔、差分间距、逃逸长度和敏感性等要求，由后续支持这些要求的工具执行并核验；不能把规划完成当作实际执行完成。

## 离线计算入口与模式

```text
node <skill>/scripts/pcb-preroute.mjs --project-root <项目> --input <请求JSON> --mode <模式> --output <项目内目录>
```

请求结构、单位和层映射见[预走线数据约定](../../schemas/pcb-routing.md#预走线公共请求)。根据本次问题选择模式：

| 模式 | 用途 |
| --- | --- |
| prepare | 按明确的 board/policy 和 source/branch/preroute 声明构造网络铜岛，输出冻结输入 |
| fanout / route | 生成两层出口或路径候选，并做独立几何与端点检查 |
| verify | 对冻结输入和已有候选重新核对铜接触及规则 |
| diagnose | 分析可达区域、边界网络及有限释放条件 |
| scan / joint-fanout | 扫描孔位与源引线，组合相容的出口方案 |
| transition-plan | 按任务与角色生成同层变径或孔后变粗的过渡方案 |
| paths | 从线、孔和焊盘接触关系构建关键端点铜路径图 |
| repair-plan | 分析阻挡网络，提出有限角色或整网回退范围 |
| prune / shortcut | 清理指定普通网的冗余铜或优化同层绕行，保持连接 |
| compose | 从相同冻结几何下的已有完整路径中选择相容组合 |
| ground | 估算潜在地空间及连接条件 |

冻结输入和覆盖范围见[数据约定](../../schemas/pcb-routing.md#冻结预走线输入与覆盖)。

## 最小运行示例

使用独立样例目录，运行随包的[两焊盘请求](../../assets/pcb-routing/preroute-request.json)：

```text
node "<skill>/scripts/pcb-preroute.mjs" --project-root "<独立样例目录>" --input "<skill>/assets/pcb-routing/preroute-request.json" --mode prepare --output evidence/preroute-prepare
node "<skill>/scripts/pcb-preroute.mjs" --project-root "<独立样例目录>" --input evidence/preroute-prepare/input.json --mode route --output evidence/preroute-example --python "<数值环境的python>"
node "<skill>/scripts/pcb-preroute.mjs" --project-root "<独立样例目录>" --input evidence/preroute-prepare/input.json --candidate evidence/preroute-example/route-result.json --mode verify --output evidence/preroute-verify
```

也可直接对样例请求运行 route。样例尺寸与规则仅用于演示；真实项目使用自己的板框、几何和规则。已有候选可以用同一份冻结输入重放检查。

## 结果怎么看

结果目录保留冻结输入、完整候选和检查报告，命令行返回摘要。核对：

- 实际连接的网络和端点、未完成部分及检查问题。
- 本轮采用的规则、层和几何覆盖范围。
- 失败属于空候选域、有限搜索无解、预算耗尽还是规则拒绝。
- 本轮结果是出口、局部路径、完整网络还是诊断建议。

有限搜索失败不代表连续空间无解；compose 只比较已有路径集合，也不能据此判定整板无解。距离和路径长度不能单独证明回流、电磁或热性能满足要求。

本页工具没有原生写入能力。需要应用候选时，使用支持该候选的转换和写回入口，核对当前现场、实际写入、保存与回读。

## 必要限制

### 出口与过渡

孔位可用还要检查源引线、全层占位、目标层接续和其他出口。搜索半径、格点、铜与钻孔间距、板边距离及孔尺寸由项目或搜索设置提供。

只有实际线段与孔已形成对应出口，才释放它的规划预留。过渡方案继续遵守网络角色的线宽和允许层要求，不能把普通细支路当作载流主干。

### 局部修复与清理

局部回退保留其他角色共享的铜；撤回角色时清除对应旧引出授权，整网回退后恢复完整角色集合。清理和捷径优化须重新检查全部端点连接，保留功率、Kelvin 和配对网络等保护要求。

局部改善同时检查关键路径及范围外保持，不能只看总长度或总分。

### 预算与续接

同一任务的出口、孔位、寻路和重布共用预算。续接使用原任务保存的输入、选项、预留和已接受结果，避免重复计分或丢失条件。输入变化时重新确认已有结果是否仍适用。

## 地空间估算的技术接口

```text
node <skill>/scripts/pcb-preroute.mjs --project-root <项目> --input <冻结输入JSON> --candidate <候选铜JSON> --mode ground --python <解释器>
```

从焊盘、铜、孔、板边和显式禁区估算两层潜在铺铜空间，分析地焊盘可达性及声明范围内的跨层连接条件；必要时在有限候选中选择连孔。

输出和覆盖标记见[地空间输出约定](../../schemas/pcb-routing.md#地空间输出)，用途见[地空间诊断](pcb-ground-space.md)。实际铺铜、回流和接地过孔仍按对应阶段核验。
