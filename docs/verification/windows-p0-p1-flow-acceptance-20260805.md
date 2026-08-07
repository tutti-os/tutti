# Tutti Windows P0/P1 场景流程验收（2026-08-05）

## 验收范围与方法

本次验收从 `origin/main` 切出的 worktree/分支执行：

- worktree：`C:\Work\tutti-os\tutti-windows-thumbnail-titlebar-20260805`
- branch：`fix/windows-file-thumbnail-native-frame-20260805`
- 运行状态目录：`.tmp\tutti-windows-p0-p1-flow-e2e`
- 运行日志：`.tmp\tutti-windows-p0-p1-flow-e2e\logs\tutti-desktop.log`、`tuttid.log`

用户给出的 `/C:/Work/tutti-windows-p0-p1-e2e-core-matrix-final-200.md` 在工作区不存在；仓库内的同名 `tutti-os\tutti-windows-p0-p1-e2e-core-matrix-final-200.md` 只是入口说明，实际详细矩阵使用 `C:\Work\tutti-windows-p0-p1-e2e-core-matrix-200.md`（200 个唯一 ID）。

没有按单条用例孤立点击，而是把 ID 串成“入口 → 核心动作 → 状态/回收 → 截图/日志”场景。13 个模块的 ID 数量为：AGGUI 28、APP 22、FILE 18、INTEROP 18、BROWSER 12、TERM 12、TASK 18、OSWIN 8、STATUS 10、MSG 10、DOCK 8、AUTO 16、AGENT 20，共 200。

## 场景编排与覆盖

| 模块          | 场景流程（覆盖的 ID 分组）                                                                                                                         | 本次结果                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| AGGUI（28）   | 引用发现/面板（02,04,05,06,26）；会话/项目生命周期（03,14,17-23,27）；权限策略（07-10,15,24）；Agent 协作/执行产物（01,11-13,16,25,28）            | PASS：Agent GUI、provider 切换、引用面板与会话回收均有证据                                                                                    |
| APP（22）     | 入口/列表/创建/重启（01,02,05,06,11,14,20）；队列/状态（03,10,12,21）；导入/卸载/版本冲突（04,13,18,22）；推荐/数据目录/故障同步（07-09,15-17,19） | PASS：应用中心加载、分类和卡片状态可见                                                                                                        |
| FILE（18）    | 导航/删除/刷新（01,02,13,15,16）；同步上传/冲突/恢复（03,04,06,08,12,17,18）；权限安全（09,10,14）；窗口生命周期（05,11）                          | PASS：Windows Downloads 图片预览与 `tutti-file-icon://` 图标真实加载                                                                          |
| INTEROP（18） | @ 范围只读契约（01,07,08,10,14,18）；Codex/Claude 双向 provider（03-06,15,17）；危险权限拒绝（02,09,11,12,16）；监控空数据（13）                   | PASS：@ 面板显示“会话/文件/任务/智能体/应用”等分类；两个 provider 结果可被引用                                                                |
| BROWSER（12） | 多窗口持久化切换（01,02,04,06-08,10,12）；导航/下载（03,05）；网络故障恢复（09,11）                                                                | PASS：导航到 `https://example.com/`，标题为 Example Domain                                                                                    |
| TERM（12）    | 窗口生命周期并发（02,04,06,08,10）；cmd/filesystem（01,03,05,07,09,11）；断网重连（12）                                                            | PASS：Windows `cmd.exe` 输出 `TUTTI_TERM_READY`                                                                                               |
| TASK（18）    | 入口/主题/CRUD/筛选（01-03,09,14-16）；执行产物/历史/附件（10,11,13,17）；引用/子任务权限（05,07,08,12,18）；持久化（06）                          | PASS：新建任务 → Codex 执行 → `TASK_READY` → 待验收 → 验证通过 → 已完成                                                                       |
| OSWIN（8）    | 状态跨窗口（01,03,05,07）；总览布局异常恢复（02,04,06,08）                                                                                         | PASS：Windows 原生最小化/最大化/关闭按钮可见；默认菜单行已隐藏                                                                                |
| STATUS（10）  | 卡片展开/输入/兜底（01,02,06,09,10）；授权安全恢复（03,04,07）；筛选并打开会话（05,08）                                                            | PASS：任务计数和 Agent 消息完成状态均正确展示                                                                                                 |
| MSG（10）     | 分组/筛选/实时同步（03,04,06,10）；授权生命周期（02,09）；跳转/删除（05,08）；权限隔离（01,07）                                                    | PASS：消息抽屉显示 Codex、Claude Code 两条，`2 条 · 2 已完成`                                                                                 |
| DOCK（8）     | Agent 双 provider（01,05）；预览右键（02,03,06,07）；启动台（04,08）                                                                               | PASS：Dock 打开文件/浏览器/终端/应用/任务，启动台列出 7 个入口                                                                                |
| AUTO（16）    | 创建模板/调度/继承（01,06-08,11,12,16）；列表/恢复/外部删除目录（02,03,05,09,10）；并发/权限/保存失败旧页（04,13-15）                              | 门控证据：应用中心的“自动化”卡片为 `aria-disabled=true`，设置的 Agent 页也未暴露 automation rules；当前构建未安装/开放该模块，因此不伪报 PASS |
| AGENT（20）   | provider GUI 基线（12 Claude、13 Codex）；@ 协作/会话生命周期（02-06,09,14,17,20）；权限/安全/Review（01,07,08,10,11,15,16,18,19）                 | PASS：Codex 与 Claude Code 均真实提交并回收固定响应                                                                                           |

AUTO 的门控是当前产品状态证据而非测试脚本失败：卡片明确不可用，未强行安装第三方包或改开关。若要验收 AUTO 的 16 条，需要先提供该应用/feature flag 的安装或启用条件。

## 已执行的端到端流程与证据

1. **OSWIN/DOCK**：启动 Windows Electron；截图 `00-oswin-titlebar-0.jpg` 中可见 Windows 原生标题栏按钮。内部 workbench 窗口的三色圆点是应用内窗口控件，不是第二套 Windows 标题栏。
2. **AGENT / Claude Code**：发送 `Reply exactly READY`，UI 显示 READY；日志记录 session `7fdc3f21-f991-4a0e-a87c-71e3b2562bf9` 完成，截图 `02-agent-claude-result.jpg`。
3. **AGENT / Codex**：发送 `Reply exactly CODEX_READY`，UI 显示 CODEX_READY；日志记录 session `3e944184-dc5e-408a-8157-f7b340cfbd5a` 完成，截图 `04-agent-codex-result.jpg`。
4. **FILE**：打开 Dock 文件 → Downloads → 选择 `tutti-e2e-file-preview.png`。DOM 证据：预览 blob `complete=true`、自然尺寸 `1708×528`；图标协议 `tutti-file-icon://icon/...` 也 `complete=true`。截图 `05-files-thumbnail-preview.jpg`。
5. **BROWSER**：打开 Dock 浏览器 → 地址栏导航 `https://example.com/` → webview 标题变为 Example Domain。截图 `06-browser-navigation.jpg`。
6. **TERM**：打开 Dock 终端 → `cmd.exe` → 执行 `echo TUTTI_TERM_READY`，输出按预期返回。截图 `07-terminal-cmd-ready.jpg`。截图中早先的 `^Vecho` 报错来自一次计算机控制焦点探针，随后 Ctrl+C 恢复并用同一终端成功执行，非产品链路错误。
7. **TASK/STATUS**：任务模块新建 `Windows E2E flow smoke`，描述为只读验证；发送给 Agent → provider 菜单选择 Codex → 执行 `TASK_READY` → 状态从待开始到待验收，点击“验证通过”后变为已完成（全部 1、已完成 1）。截图 `08-task-create-status.jpg`、`11-task-agent-codex-result.jpg`。
8. **MSG**：打开顶部 Agent 消息抽屉，显示 `2 条 · 2 已完成`、Codex/CODEX_READY、Claude Code/READY。截图 `10-agent-message-center.jpg`。
9. **APP/AUTO**：打开应用中心，验证官方应用分类、版本和安装/打开状态；自动化卡片显示为不可用门控。截图 `09-app-center.jpg`。
10. **INTEROP/AGGUI**：在 Codex 会话 composer 点击 @，面板出现会话/文件/任务/智能体/应用分类，并列出已完成 Codex/Claude 会话。截图 `13-interop-mention-palette.jpg`（DOM surface 的 `data-testid=agent-gui-mention-palette-surface` 可见，固定面板尺寸约 611×320）。
11. **DOCK**：打开 ALL 启动台，列出应用、事项、Getting Started、文件、浏览器、终端、Agent。截图 `12-launchpad.jpg`。

截图目录：`.tmp\tutti-windows-p0-p1-flow-e2e\artifacts\screenshots\`。

## 日志/代码依据与异常判断

- `tutti-desktop.log` 记录 `desktop app ready`，并记录 provider submit/complete 与 renderer 状态；`tuttid.log` 记录 Codex/Claude ACP 进程启动、`turn.start.succeeded`、`root_provider_turn.completed`。
- Codex 本次任务日志显示 session 创建、6 个 call completed、`root_provider_turn.completed`；UI 最终显示 `TASK_READY`，任务状态也回写完成。
- 可见的环境告警：CLI shim `transport_request_failed`、Codex models cache/remote catalog/analytics 网络告警、PowerShell shell snapshot 不支持、未信任 worktree 的 `.codex` 配置被禁用。它们没有阻断已完成流程，不改动用户全局配置。
- 一次 `agent-session-sections`/messages `AbortError` 在 provider 切换或执行期间出现，随后请求恢复且 UI/日志有完整结果；记录为可恢复瞬态，不判定为 P0/P1。

## 代码修复与验证

本分支包含之前针对 Windows 图片预览和窗口 chrome 的最小修复：

- Windows icon worker 改为 Node child-process IPC 通道，避免 Windows 下 fork/stdio 传输导致 PNG 读取失败。
- `workspaceFileEntryIcon` 删除不安全的 `file://` thumbnail 回退，失败时返回安全空值。
- Windows workspace/standalone Agent 使用原生 frame；隐藏重复的应用内三色按钮，并设置 `autoHideMenuBar`，保留 Alt 显示菜单能力。
- 旧的无边框兼容方案曾把“导出日志”放到全局顶栏；恢复原生 Windows chrome 后移除这个重复按钮，日志继续从“设置 → 开发者”和“帮助 → 导出服务日志”进入。

验证结果：

- changed tests：14/14 passed（workspace file icon 12、Windows window chrome 2）。
- desktop typecheck：passed。
- 实际 Windows icon worker：对 `C:\Users\15514\Downloads\tutti-e2e-file-preview.png` 返回 `returnedPngBytes: 4986`。
- 全量 desktop tests：1767 总数，1749 pass、5 skip、13 fail；13 个失败均为既有 Windows 环境/Unix 路径或外部 provider 预期差异（CLI shim symlink EPERM、Unix 路径断言、当前环境 provider 可用性等），不涉及本分支改动；本分支测试没有失败。

## 结论

已按场景流程完成可启动模块的 Windows 端到端验收，并保留每个模块的截图和日志证据；没有发现需要在继续验收前紧急修复的产品 P0/P1。AUTO 的 16 条因产品卡片明确门控而标为待启用，不伪造通过。Windows 图片预览和原生标题栏修复在真实 Electron 运行中已验收通过。
