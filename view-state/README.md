# 项目状态面板

随 FlitRealize 分发的只读项目面板。它展示 `CURRENT_HANDOFF.md` 中作者提供的梗概、来源与当前通道健康状态，不生成设计、修改项目或判断工程进度。尺寸与样式集中在 `public/app.css`。

## 启动

需要 Node.js 22+ 和浏览器；面板本身没有第三方 npm 运行依赖。在 Skill 根目录运行：

```text
node view-state/server.mjs --project-root "<PROJECT_ROOT>"
```

打开 [127.0.0.1:49700](http://127.0.0.1:49700)。`--port` 指定其他端口，页面 `projectRoot` 参数或项目选择按钮可切换目录。只读命令行摘要使用：

```text
node view-state/cli.mjs --project-root "<PROJECT_ROOT>"
```

## 由 Skill 拉起面板

新建或首次接管项目时按[主 Skill](../SKILL.md#项目续接)打开；后续复用，用户不需要时跳过。启动失败继续当前硬件工作。

1. 请求 `/api/health`，按[健康返回约定](../schemas/project-records.md#面板健康返回)确认后复用。不同项目通过 URL 参数使用同一服务。
2. 没有服务时使用已确认的 Skill 与项目目录启动。端口被其他程序占用时换空闲端口，不终止未知进程；Windows 后台 `Start-Process` 使用 `-WindowStyle Hidden`，正确引用路径。
3. 健康检查通过后打开 `<服务地址>/?projectRoot=<URL编码的项目绝对路径>`，用页面项目名和 `/api/status?projectRoot=<同一路径>` 核对所查看的项目。浏览器不可用时提供地址。

停止前台服务用 Ctrl+C；后台只停止本次启动且归属明确的进程。复用的服务可能仍被其他项目页面使用。

## 展示合同

唯一工程内容来源是项目的 `CURRENT_HANDOFF.md`。文稿写什么、事实归属和变化后更新哪里见 [0.1](../docs/0.1-continuation.md)；本页维护面板的启动、兼容与显示行为；解析格式统一见[项目记录数据约定](../schemas/project-records.md)。

固定参考树使用 0.x～6.x 编号，项目正文保留自己的编号。面板按阶段和主题标题关联原文：PCB 3.4 集中展示“网络规则”，3.5 展示“布局与空间”。没有映射的内容仍可阅读全文，不为面板重排项目章节。

当前阶段、摘要、网络表格的标记、示例和字段语义统一见[项目记录数据约定](../schemas/project-records.md#面板标记)。

### 兼容与显示

旧布局标题继续兼容。旧布线规则、线宽调整、网络配色及合并标题在 3.4 保留原文入口；没有显式表格时不猜行。相关主题首次整理时可合并到“网络规则”，保留原证据和其他设计章节。

缺少文稿、梗概或专用字段时显示未记录／未提供，旧文稿仍能阅读全文。文稿更新时间不解释为检查时间。首次默认英文，记住语言选择；命名在 `public/names.mjs`，来源在 `public/navigation.mjs`，语言切换不改变来源身份。

## 通道健康与刷新

面板从宿主 `host.json` 或 `FLITREALIZE_EDA_CHANNEL` 选择当前通道，并显示 CLI/Bridge 标签：

- CLI：按配置的可执行文件运行只读 `doctor`，核对连接、版本及结果通道；不创建会话、ensure、重连或执行操作。
- Bridge：读取会话并请求 loopback `/health`，核对服务、协议、会话和 EDA 连接；不返回令牌。

通道选择与配置见 [0.3](../docs/0.3-easyeda-pro.md#选择执行通道)。显式 `--home <FlitRealize目录>` 优先于环境默认宿主目录；Bridge 路径规则见 [适配器状态目录](../adapters/easyeda-pro/README.md#状态目录)。相对路径以服务启动目录解析。

前台每 5 秒读取文稿和健康状态，也可手动刷新。刷新保留阅读位置；同项目读取失败保留旧内容并提示，切换失败不显示旧项目数据。连接健康只说明通道情况，不证明当前项目或设计已核验。

## 实现与验证

`lib/handoff.mjs`、`network-table.mjs` 解析作者合同，`project.mjs` 处理只读路径，`bridge.mjs` 读取所选通道健康。`server.mjs` 仅绑定 127.0.0.1，提供 GET 状态/原文与静态页面；原文阅读页按标题和行号定位并可下载文件。

导航、命名和渲染位于 `public/`。源码仓库的 `npm test` 包含解析、通道、导航和 HTTP 边界检查；运行包不包含测试。面板不扫描电路设计稿和证据、不监听文件、不聚合工程完成度。
