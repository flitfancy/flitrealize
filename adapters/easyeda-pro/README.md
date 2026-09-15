# EasyEDA Pro Adapter（内嵌通道）

这是 FlitRealize 当前 Provider `easyeda-pro` 的**本机执行通道**，不是完整 API 文档产品。

职责只有：启动/连接本地 Bridge，在 EasyEDA Pro API 环境中执行 flitrealize 传入的 Action 代码。  
硬件业务 Action 仍在仓库根目录 `scripts/actions/easyeda-pro/`。

## 冷启动

```text
cd <skill>/adapters/easyeda-pro
npm install
node <skill>/scripts/eda-host.mjs register --eda easyeda-pro --adapter-root <skill>/adapters/easyeda-pro
node <skill>/scripts/eda-host.mjs ensure --eda easyeda-pro --require-eda
```

还需要：EasyEDA Pro 客户端、API Gateway 扩展（`https://jlcext.com` 或 Pro 内扩展管理），以及 Node ≥ 22（与 flitrealize 一致）。

会话与请求记录写在本机状态目录（默认 Windows `%LOCALAPPDATA%\FlitRealize\bridge\easyeda-pro`），不进 git。

恢复与超时语义见 [references/bridge-recovery.md](references/bridge-recovery.md)。

## 来源

通道实现来自 EasyEDA Pro API Skill（`easyeda-api-skill`）中与 flitrealize host 契约对应的运行时文件；完整 API 类文档与独立使用方式仍以该上游项目为准。
