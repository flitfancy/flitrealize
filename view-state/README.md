# View State

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

1. 请求 `/api/health`；仅当 `service: "flitrealize-view-state"`、`schemaVersion:1`、`readOnly:true` 时复用。不同项目通过 URL 参数使用同一服务。
2. 没有服务时使用已确认的 Skill 与项目目录启动。端口被其他程序占用时换空闲端口，不终止未知进程；Windows 后台 `Start-Process` 使用 `-WindowStyle Hidden`，正确引用路径。
3. 健康检查通过后打开 `<服务地址>/?projectRoot=<URL编码的项目绝对路径>`，用页面项目名和 `/api/status?projectRoot=<同一路径>` 核对所查看的项目。浏览器不可用时提供地址。

停止前台服务用 Ctrl+C；后台只停止本次启动且归属明确的进程。复用的服务可能仍被其他项目页面使用。

## 展示合同

唯一工程内容来源是项目主文稿。`ViewState:`、`当前阶段:`、`ViewStateTable: networks` 的写法及同步方式只在 [0.1 文稿约定](../references/0.1-continuation.md#给-view-state-的简短交接说明)维护。

- 固定参考树组织 0.x～6.x；文稿章节与明确主题映射来源，未映射内容仍可阅读全文。界面编号不构成工程状态或审批步骤。
- PCB 3.4 展示布局，3.5 合并展示网络规则/改宽/配色。网络三列表读取作者显式标记，格式与来源限定见 [0.1 表格合同](../references/0.1-continuation.md#pcb-主题与面板对应)；不从散文、其他文件或默认色表补值。
- 缺少文稿或梗概分别显示未记录/未提供；重复标记和错误表格提示检查。旧文稿仍能阅读全文，面板不自动补写。
- 自动事实表及代码围栏中的内容不进入梗概导航。梗概本身不代表验收；文稿更新时间不解释为检查时间。
- 首次默认英文，记住语言选择。命名映射在 `public/names.mjs`，来源在 `public/navigation.mjs`；语言切换不改变来源身份。固定英文备份不参与执行或命名。
- 当前模式、工程进度和库存匹配无专用字段时显示未提供；不推断或填入示例数据。

## 通道健康与刷新

面板从宿主 `host.json` 或 `FLITREALIZE_EDA_CHANNEL` 选择当前通道，并显示 CLI/Bridge 标签：

- CLI：按配置的可执行文件运行只读 `doctor`，核对连接、版本及结果通道；不创建会话、ensure、重连或执行 Action。
- Bridge：读取会话并请求 loopback `/health`，核对服务、协议、会话和 EDA 连接；不返回令牌。

通道选择与配置见 [0.3](../references/0.3-easyeda-pro.md#选择执行通道)。显式 `--home <FlitRealize目录>` 优先于环境默认宿主目录；Bridge 路径规则见 [Adapter 状态目录](../adapters/easyeda-pro/README.md#状态目录)。相对路径以服务启动目录解析。

前台每 5 秒读取文稿和健康状态，也可手动刷新。刷新保留阅读位置；同项目读取失败保留旧内容并提示，切换失败不显示旧项目数据。连接健康只说明通道情况，不证明当前项目或设计已核验。

## 实现与验证

`lib/handoff.mjs`、`network-table.mjs` 解析作者合同，`project.mjs` 处理只读路径，`bridge.mjs` 读取所选通道健康。`server.mjs` 仅绑定 127.0.0.1，提供 GET 状态/原文与静态页面；原文阅读页按标题和行号定位并可下载文件。

导航、命名和渲染位于 `public/`。源码仓库的 `npm test` 包含解析、通道、导航和 HTTP 边界检查；运行包不包含测试。面板不扫描 Contract/证据、不监听文件、不聚合工程完成度。
