> 本文件是英文参考文件 [environment.md](../../../../../references/providers/easyeda-pro/environment.md) 的中文只读镜像，供人工阅读和审阅。实际执行仍以英文源文件为准。
> 同步日期：2026-08-27（Asia/Shanghai）
> 英文源文件 SHA-256：`0BCA29196755434B000021CD122112B81B946CF7EE302F7DD94027EA4EAF8C38`

# EasyEDA Pro 环境与 Bridge

仅在建立、诊断或复用本机 EasyEDA 执行通道时读取本流程。它输出分层且有边界的通道结论，不授权 EDA 写入。

## 输入

- 预期 Provider：`easyeda-pro`；
- 只保存在主机配置中的 Adapter 安装目录；
- 已知时的预期项目/文档身份；
- 下一 Action 所需的能力。

## 注册一次，每个实时会话 ensure

Bridge 服务端和机器专属 Adapter 放在可移植 Skill 之外。安装位置只注册一次，之后由 helper 启动或复用：

```text
node scripts/eda-host.mjs register --eda easyeda-pro --adapter-root <adapter-root>
node scripts/eda-host.mjs ensure --eda easyeda-pro --require-eda
```

主机配置可以包含本机路径；项目状态和公开 Skill 不得包含。项目可以在 `.flitrealize/project.json` 声明预期 EDA 和文档。声明与实际连接不一致时，任何实时操作前都按身份硬失败处理。

已注册 Provider 目录就是 allowlist。其他 EDA 产品或未注册 Adapter 不得悄悄通过 `easyeda-pro` 路由。

## 只复用有边界的握手

每个 agent 会话第一次实时访问 EDA 前运行轻量握手，不必每轮聊天都执行。只有以下内容全部不变时才复用：

- Bridge session ID；
- Adapter 与 EDA 身份/版本；
- 选定窗口；
- 目标项目/文档；
- 所需能力指纹。

断线、EDA 重启、窗口/文档切换、Adapter/API 版本变化、能力失败或项目不匹配后重新探测。旧握手成功不能证明新选中文档。

## 只恢复一次，然后停止

如果 Bridge 启动时 EasyEDA 网关已用完重试次数，helper 会返回 `EDA_NOT_CONNECTED`。执行一次 **API Gateway -> 重新连接**。通常先启动 Bridge 再打开 EasyEDA 即可避免。如果一次重连仍无法建立声明的 EDA 和文档，就停止并报告观察状态。

使用 helper，不直接调用未鉴权 HTTP。每会话令牌由 Adapter 保管，不进入提示词，只返回紧凑结构化状态。原始代码执行只是传输，不等于授权或证明。

## 输出分层通道结论

不得把结果折叠成一个笼统的 `connected: true`。分别报告：

- 主机进程可达；
- Agent 已向本地 Adapter 鉴权；
- Adapter 身份/版本已接受；
- EasyEDA 网关已连接；
- 活动项目/文档已确认；
- 所需 API 能力存在。

Agent 鉴权和 EDA 网关配对是两个不同结论。网关不能提供配对凭据时，把它归类为仅 localhost 的本地开发模式，通过只读探针确认真实文档，不得把它作为共享主机或敌对主机的安全边界。

只有下一流程要求的各层结论通过后才可继续。
