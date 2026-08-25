# FlitRealize

[English](README.md)

FlitRealize 是一个电子硬件工程 Skill，用于把有持续状态的项目从需求和架构推进到原理图、PCB、原型下单、安全上电以及证据驱动的改版。

> 当前状态：`v1.0.0-rc.1` 公开候选版。稳定版发布前仍需完成干净环境测试。

## 适用范围

FlitRealize 专用于项目级电子硬件工作，包括：

- 需求、架构、器件和原理图决策；
- PCB 布局、布线意图、制造评审和 EDA 自动化；
- 原型下单、安全上电、调试和改版；
- 在不同对话之间隔离并续接项目状态。

它不是通用的软件、网站、内容创作或项目管理 Skill，也不会因为孤立器件事实或无需项目状态的一步式 EDA 问题而触发。

## 兼容性

本 Skill 遵循开放的 Agent Skills 结构，并主要在 Codex 中测试。只有聊天或只读工具的宿主仍可规划和评审；相应的文件、终端、浏览器和 EDA 工具齐全时，才能执行对应操作。本地知识 catalog 是可选增强，不是运行前提。

## 在 Codex 本地安装

把本仓库放到：

```text
$HOME/.agents/skills/flitrealize
```

GitHub 远端公开后，也可以让 `$skill-installer` 从仓库地址安装。使用 `$flitrealize` 可显式调用；请求匹配 description 时 Codex 也可以自动选择。新安装或改名后如果没有出现，请重启 Codex。

当前发现和安装行为以 [OpenAI 官方 Skill 文档](https://developers.openai.com/codex/skills) 为准。独立 Skill 适合本地使用和试验；以后需要更广泛的可安装分发时，可以再包装成 Plugin。

## 仓库结构

```text
flitrealize/
├── SKILL.md                 # 运行入口
├── agents/openai.yaml       # Codex 界面元数据
├── references/              # 按需加载的运行参考
├── docs/zh-CN/              # 中文人工阅读镜像
├── scripts/                 # 确定性校验与打包
└── .github/workflows/       # 仓库自动校验
```

发布 ZIP 只包含 `SKILL.md`、`agents/` 和 `references/`。作者工作区、具体项目记录、本地 catalog 和优化历史不会进入公开制品。

## 校验和打包

```powershell
python scripts/validate.py
python scripts/package_release.py
```

打包命令会在 `dist/` 下生成可复现 ZIP 和 SHA-256 文件。英文指令变化后，应同步修改相应中文内容，然后更新来源哈希：

```powershell
python scripts/update_translation_hashes.py
```

## 许可证

目前尚未选择公开许可证。正式公开仓库或 Release 之前，需要加入明确的 `LICENSE`。
