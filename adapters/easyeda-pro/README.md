# EasyEDA Pro 执行通道

本机客户端 CLI 与网页 Bridge 都由 FlitRealize 原宿主 `eda-host.mjs` 调度；硬件 Action 仍在仓库根目录 `scripts/actions/`，这里不维护第二套业务入口。

宿主的 `--channel cli|bridge`、`--cli-executable PATH` 及会话复用方式见 [0.3](../../references/0.3-easyeda-pro.md#选择执行通道)，高层业务 CLI 使用原参数。官方 CLI 实现在 `scripts/providers/easyeda-pro/cli-channel.mjs`；这里提供 Bridge 运行时。CLI 的只读 API、doctor、会话与原请求查询已实测，其他操作按各自说明验证。

网页或明确选用 Bridge 时才按 [0.4](../../references/providers/easyeda-pro/0.4-environment.md)安装 Gateway、通道依赖并建立连接；复用已连接服务。Bridge 的请求机制见 [bridge-recovery.md](references/bridge-recovery.md)，共同恢复判断仍在 0.3。

CLI 的本机回执在 FlitRealize 宿主目录 `cli/easyeda-pro/requests/<会话哈希>/`：请求认领文件与各阶段文件不可变，终态优先于 unknown，不通过重发 Action 恢复。Bridge 使用下节目录；共同未知结果处理只按 0.3。

## 状态目录

Bridge 服务、控制脚本和 View State 使用同一套路径规则，按以下优先级选择目录；`session.json`、日志和请求记录均位于该 Bridge 目录中：

1. 显式目录参数：View State 的 `--home <目录>` 从 `<目录>/bridge/easyeda-pro` 读取，优先于环境变量；该选项只指定面板读取的位置。
2. `FLITREALIZE_BRIDGE_STATE_DIR`：直接指定 Bridge 目录。
3. `FLITREALIZE_HOME`：使用其下的 `bridge/easyeda-pro`。
4. Windows 且已设置 `LOCALAPPDATA`：`%LOCALAPPDATA%/FlitRealize/bridge/easyeda-pro`。
5. 已设置 `XDG_RUNTIME_DIR`：`$XDG_RUNTIME_DIR/flitrealize/bridge/easyeda-pro`。
6. 已设置 `XDG_STATE_HOME`：`$XDG_STATE_HOME/flitrealize/bridge/easyeda-pro`。
7. 兜底：`~/.local/state/flitrealize/bridge/easyeda-pro`。

相对目录以当前入口进程的启动工作目录为基准转成绝对路径，并在启动子进程前固定。若要从不同工作目录分别启动 Bridge 和面板，请使用相同的绝对目录环境变量。`--home` 接收 FlitRealize 根目录，不能把最终 Bridge 目录直接传给它。

`host.json` 等注册配置继续使用 `FLITREALIZE_HOME`、Windows 的 `LOCALAPPDATA` 或 Linux 的 `XDG_CONFIG_HOME`/`~/.config`；配置目录和 Bridge 运行状态目录无需相同。旧版 Bridge 忽略 `FLITREALIZE_HOME` 和 `XDG_STATE_HOME`，升级后已设置这些变量的用户可能改用新目录；已有进程仍使用其启动时的目录，可用 `FLITREALIZE_BRIDGE_STATE_DIR` 明确指向原目录，待未决请求处理完毕后再切换。

## 来源

Bridge 实现来自 EasyEDA Pro API Skill（`easyeda-api-skill`）中与 flitrealize host 契约对应的运行时文件；完整 API 类文档仍以上游和官方资料为准。客户端 CLI 通道由原宿主适配，验证范围按其回执保留。
