# EasyEDA Pro 执行通道

本机客户端 CLI 与网页 Bridge 都由 FlitRealize 原宿主 `eda-host.mjs` 调度；硬件操作仍在仓库根目录 `scripts/actions/`，这里不维护第二套业务入口。

宿主的 `--channel cli|bridge`、`--cli-executable PATH` 及会话复用方式见 [0.3](../../docs/0.3-easyeda-pro.md#选择执行通道)，高层业务 CLI 使用原参数。官方 CLI 实现在 `scripts/providers/easyeda-pro/cli-channel.mjs`；这里提供 Bridge 运行时。CLI 的只读 API、doctor、会话与原请求查询已实测，其他操作按各自说明验证。

网页或明确选用 Bridge 时才按 [0.4](../../docs/providers/easyeda-pro/0.4-environment.md)安装 Gateway、通道依赖并建立连接；复用已连接服务。Bridge 的请求机制见 [bridge-recovery.md](references/bridge-recovery.md)，共同恢复判断仍在 0.3。

CLI 的本机回执在 FlitRealize 宿主目录 `cli/easyeda-pro/requests/<会话哈希>/`：请求认领文件与各阶段文件不可变，终态优先于 unknown，不通过重发操作恢复。Bridge 使用下节目录；共同未知结果处理只按 0.3。

## 状态目录

Bridge 服务、控制脚本和项目状态面板使用同一套路径规则，按以下优先级选择目录；`session.json`、日志和请求记录均位于该 Bridge 目录中：

1. 显式目录参数：项目状态面板的 `--home <目录>` 从 `<目录>/bridge/easyeda-pro` 读取，优先于环境变量；该选项只指定面板读取的位置。
2. `FLITREALIZE_BRIDGE_STATE_DIR`：直接指定 Bridge 目录。
3. `FLITREALIZE_HOME`：使用其下的 `bridge/easyeda-pro`。
4. Windows 且已设置 `LOCALAPPDATA`：`%LOCALAPPDATA%/FlitRealize/bridge/easyeda-pro`。
5. 已设置 `XDG_RUNTIME_DIR`：`$XDG_RUNTIME_DIR/flitrealize/bridge/easyeda-pro`。
6. 已设置 `XDG_STATE_HOME`：`$XDG_STATE_HOME/flitrealize/bridge/easyeda-pro`。
7. 兜底：`~/.local/state/flitrealize/bridge/easyeda-pro`。

相对目录以当前入口进程的启动工作目录为基准转成绝对路径，并在启动子进程前固定。若要从不同工作目录分别启动 Bridge 和面板，请使用相同的绝对目录环境变量。`--home` 接收 FlitRealize 根目录，不能把最终 Bridge 目录直接传给它。

`host.json` 等注册配置继续使用 `FLITREALIZE_HOME`、Windows 的 `LOCALAPPDATA` 或 Linux 的 `XDG_CONFIG_HOME`/`~/.config`；配置目录和 Bridge 运行状态目录无需相同。旧版 Bridge 忽略 `FLITREALIZE_HOME` 和 `XDG_STATE_HOME`，升级后已设置这些变量的用户可能改用新目录；已有进程仍使用其启动时的目录，可用 `FLITREALIZE_BRIDGE_STATE_DIR` 明确指向原目录，待未决请求处理完毕后再切换。

## 来源与 API 资料

Bridge 实现来自 EasyEDA Pro API Skill（`easyeda-api-skill`）中与 flitrealize host 契约对应的运行时文件；客户端 CLI 通道由原宿主适配，验证范围按其回执保留。API 查询语料保存在 `api-reference/`，来源与版本以 `provenance.json` 为据。

### 查询筛选与验证资料

`scripts/api-reference.mjs search` 可用 `--domain pcb|schematic|document|library|system` 严格筛选域、`--class <完整条目ID>` 精确筛选所属类/接口，以及 `--offset <非负整数>` 分页；`sch/dmt/pnl/lib/sys` 是域别名。筛选只依据条目归属，不依据说明文字中的跨域提及。评分与同分排序沿用现有查询；`--kind`、中文查询、默认8项及 `show` 用法不变。

```text
node <skill>/scripts/api-reference.mjs search --query get --domain pcb --kind method --limit 5 --offset 5
node <skill>/scripts/api-reference.mjs search --query get --class PCB_PrimitiveVia --limit 5
```

使用新增选项时返回 `offset`、`hasMore` 及所用筛选条件；`total` 是筛选后、分页前的匹配数。越过末页返回空数组与 `hasMore:false`，仍保留 total；未使用新增选项时保留原输出字段。host action 使用同名 `domain/class/offset` 输入，不另建查询入口。

原生源码格式的当前查询入口、4.1.71 隔离样例差异及扩展资源环境限制见 [格式与扩展验证说明](references/format-and-extension-validation.md)。旧格式/指南只提供已核验的概念摘要，没有导入整套旧文档、探针、桥接脚本或速查表对账器。

### 更新查询资料

固定官方 `easyeda/easyeda-api-skill` 仓库的完整提交 SHA，取得对应 ZIP。在仓库根目录先输出到临时目录：

```text
python scripts/update-api-reference.py --archive <官方仓库ZIP> --commit <完整提交SHA> --snapshot <日期> --output-dir <临时目录>
```

核对临时输出的版本、提交、条目数量与导入范围，再替换本目录的 `api-reference/corpus.json` 和 `api-reference/provenance.json`；旧语料与差异报告保留为项目证据。脚本只导入 `classes`、`enums`、`interfaces`、`types` 四类参考 Markdown，保留完整定义、示例、限制与原始／规范化哈希，不导入上游 Skill、执行脚本或依赖。

`provenance.json` 记录固定提交、归属、来源声明和哈希；上游声明只是来源依据，不构成新的许可授权。完整 API 说明仍以上游和官方资料为准；在线资料与客户端自带定义可能不同，更新文档不表示目标编辑器的 API 已验证。

### 源码比较与指纹

EasyEDA 原生源码的 DOCHEAD 含随会话和读取变化的信息。比较源码或生成指纹时，复用对应操作或软件适配层已有的规范化函数；各操作的比较范围不同，不统一删除所有头部。规范化用于排除会话变化，几何和对象事实仍须按该操作的范围核对。
