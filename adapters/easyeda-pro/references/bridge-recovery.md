# Bridge 请求与恢复

只在执行中断、查询旧结果或开发控制接口时读取。普通连接见本通道 [README](../README.md)；硬件流程与 Provider 入口见 [SKILL.md](../../../SKILL.md)。

## 一个请求，一份结果记录

控制脚本发起执行前生成请求 ID，记录原会话、目标窗口及代码 SHA256；服务端先保存请求记录，再向该窗口发送。代码内容和 token 不进入请求记录，结果本身可能含项目数据，按本地证据保护。

返回的 `submissionReceipt` 指向本机 `submissions/<会话ID>/<请求ID>.json`；即使调用进程没来得及输出，也可据此找回查询句柄。它只证明曾准备提交，不证明已执行。服务端记录在同一状态目录的 `requests/<会话ID>/<请求ID>.json`，执行结果以查询和现场核对为准。

```text
node <adapter>/scripts/bridge-control.mjs execute --code-file <脚本.js> --window-id <窗口ID> --json
node <adapter>/scripts/bridge-control.mjs request --request-id <原请求ID> --session-id <原会话ID> --json
```

需要与调用者报告关联时，execute 可显式给 `--request-id <UUID>`。同一会话内相同 ID、代码和窗口只对应原请求；重复提交不能作为重新执行的方法，内容冲突会被拒绝。正常续接优先 request，不重复 execute。

查询成功只表示读到了记录，具体看 `request.status`：

普通 execute 的业务返回值在 `result`，查询取得的在 `request.result`；网关错误在 `request.error`。即使查询退出码为 0、顶层 `success: true`，也须检查内层状态和业务结果。

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| running | 已接受，尚未收到终态 | 不发重复写入；稍后查询 |
| unknown | 超时、断连、重启或无法证明终态 | 保留现场，查询迟到结果或人工对账 |
| succeeded | 收到本请求对应网关的返回值 | 检查返回的 Action 结果，再回读现场 |
| failed | 收到对应网关的错误结果 | 核对可能已发生的部分修改，不把失败当成零写入 |

查询返回 not-found、读盘错误或 Bridge 不可用时，不推断“没有执行过”。原输入、提交回执和上层报告仍保留。

## 超时、断连与重启

等待超时不会取消 EDA 端代码，也不会自动重试。Bridge 保留请求归属，能接收仍来自原连接的迟到结果；其他窗口或替换后的连接不能替原请求报告成功。

记录保存在本机 Bridge 状态目录，按会话和请求 ID 分开。状态目录可由 `FLITREALIZE_BRIDGE_STATE_DIR` 指定，普通使用沿用现有本机配置。服务重启后可查询落盘的旧结果；尚无终态的旧请求只能认作 unknown，不会被重放。磁盘丢失或无法取得旧网关结果时，记录无法补造事实。

查询使用当前运行 Bridge 的认证，但 `--session-id` 必须填写被查询请求的原会话。只读查询不自动启动或重启 Bridge。旧 Bridge 不支持请求查询时，控制端明确提示能力缺口；不要在有未决操作时为升级强行重启。

请求记录不是项目主文稿，不自动清空、不自动过期删除。稳定结果需要交接时，把输入、请求句柄及必要结果纳入项目证据，再更新同一份 `CURRENT_HANDOFF.md`；不把整个本机会话目录复制进项目。

## 与 FlitRealize 衔接

FlitRealize 的报告保留 Bridge 请求句柄，主机入口提供对应只读查询：

```text
node <skill>/scripts/eda-host.mjs request --eda easyeda-pro --request-id <原请求ID> --session-id <原会话ID>
```

取得迟到结果后，应核对请求、代码版本、目标和实际对象，作为补充证据处理。原来的 Action / 批次 / 保存占用记录不会因查询自动改变；不能手改回执或删除锁来伪造完成。这个能力补齐“结果能找回来”，不是自动恢复所有事务。

## 开发接口

- `POST /execute` 保留原代码与窗口输入，可带 `requestId` 和当前 `sessionId`；响应保留原结果形态并附请求元数据。
- `GET /requests/<requestId>?sessionId=<原会话ID>` 只读查询，要求 Agent 认证。
- 协议主版本保持 2，通过 `request-status` 能力标识区分是否支持查询。
- 网关原执行消息仍带 `id` 和 `code`，不要求改造官方扩展。

Bridge 的 succeeded / failed 是传输终态，不代表 Action 成功、文档保存、DRC 或电路功能通过。
