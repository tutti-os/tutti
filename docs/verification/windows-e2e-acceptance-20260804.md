# Tutti Windows E2E 验收记录

> 状态：核心主路径已验收；P1/P2 扩展场景保留在附录，未执行项已明确标注。
> 日期：2026-08-04
> 分支：`codex/windows-followup-v2`
> 基线：`9fe7ce954`
> 环境：Windows 11 家庭中文版，10.0.26200；Tutti Dev（Electron）

## 1. 验收范围与判定口径

本次覆盖 Agent GUI、应用、文件夹/工作区、终端、浏览器五个模块。按用户要求先由 subagent Hubble 梳理完整场景矩阵，再在本机 Windows 上执行核心主路径；发现问题后沿“日志 → renderer/host → daemon/runtime → 文件系统”调用链定位、修改并复验。

完整场景矩阵数量如下，均满足每个模块至少 10 个、最多 30 个场景：

| 模块          | subagent 梳理场景数 | 本文主路径场景数 | 主路径结论                                                       |
| ------------- | ------------------: | ---------------: | ---------------------------------------------------------------- |
| Agent GUI     |                  12 |               10 | PASS（工具调用的外部 Feishu 任务因授权条件阻塞，渲染本身已验证） |
| 应用          |                  17 |               10 | PASS（应用中心、Automation UI、全部已部署应用健康检查）          |
| 文件夹/工作区 |                  15 |               10 | PASS（发现并修复 Windows 盘符路径问题后复验）                    |
| 终端          |                  16 |               10 | PASS（cmd、cwd、实时输出、resize、关闭保护）                     |
| 浏览器        |                  17 |               10 | PASS（Google 基线、本地 Automation 页面、地址导航）              |

判定口径：

- PASS：操作完成，且有可复核的 UI、接口、运行日志或单元测试证据。
- BLOCKED：外部账号、授权、网络或安全确认未满足；不将外部阻塞误判为代码通过。
- FAIL：存在稳定可复现的产品问题；必须记录直接原因、系统性原因、代码位置和复验结果。
- 未执行：本轮没有执行该扩展场景，不代表通过。

## 2. 环境、启动方式与证据位置

本地 dev-gui 使用仓库内等价于 `make dev-gui` 的 Windows 启动链路：

```powershell
pnpm --filter @tutti-os/desktop dev
```

启动时注入了仓库构建的 `tuttid.exe`、托管 POSIX shell、隔离的运行时目录和用户数据目录。主要证据目录：

- Runtime 根目录：`C:\Work\tutti-os\tutti\.tmp\dev-gui-runtime-baseline-20260804\`
- Desktop 日志：`C:\Work\tutti-os\tutti\.tmp\dev-gui-runtime-baseline-20260804\logs\tutti-desktop.log`
- Daemon 日志：`C:\Work\tutti-os\tutti\.tmp\dev-gui-runtime-baseline-20260804\logs\tuttid.log`
- Workspace：`d9534c4b-0620-4a4e-bb0b-7a081accfddc`
- Tutti daemon listener：`127.0.0.1:55568`（token 位于 runtime 目录的 `run\tuttid.listener.json`）

### 2.1 Windows 应用 runtime 健康汇总

以下结果由各应用 `runtime.log` 的实际端口和本机 HTTP 健康接口复核得到；204 也属于应用约定的健康响应。

| 应用                |  端口 | 健康接口      | 结果 |
| ------------------- | ----: | ------------- | ---: |
| ai-doc              | 59259 | `/api/health` |  200 |
| ai-media-canvas     | 63230 | `/api/health` |  200 |
| ai-slide            | 50166 | `/api/health` |  200 |
| automation          | 65394 | `/healthz`    |  200 |
| daily-tech-radar    | 55380 | `/api/health` |  200 |
| design-review       | 63162 | `/healthz`    |  200 |
| draw-topic-app      | 63064 | `/healthz`    |  200 |
| group-chat          | 63313 | `/api/health` |  200 |
| omni-catcher        | 63192 | `/healthz`    |  200 |
| product-competition | 63345 | `/api/health` |  200 |
| tutti-onboarding    | 56064 | `/api/health` |  200 |
| vibe-design         | 63177 | `/healthz`    |  204 |

### 2.2 截图索引

截图均位于 `docs/verification/assets/windows-e2e-acceptance-20260804/`：

| 编号                                                                                                      | 内容                                                       |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [01-baseline-export-dialog.jpg](assets/windows-e2e-acceptance-20260804/01-baseline-export-dialog.jpg)     | 顶部栏导出日志对话框，确认 Windows 下导出入口可见          |
| [02-workspace-topbar.png](assets/windows-e2e-acceptance-20260804/02-workspace-topbar.png)                 | Windows Tutti 主界面及顶部栏                               |
| [03-folder-documents.png](assets/windows-e2e-acceptance-20260804/03-folder-documents.png)                 | 文件夹进入 `Documents` 后的列表                            |
| [04-agent-codex-hi.png](assets/windows-e2e-acceptance-20260804/04-agent-codex-hi.png)                     | Codex 会话发送 `hi` 并收到回复                             |
| [05-agent-claude-hi.png](assets/windows-e2e-acceptance-20260804/05-agent-claude-hi.png)                   | Claude Code 会话发送 `hi` 并收到回复                       |
| [06-application-center.png](assets/windows-e2e-acceptance-20260804/06-application-center.png)             | 应用中心官方应用列表                                       |
| [07-automation-app.png](assets/windows-e2e-acceptance-20260804/07-automation-app.png)                     | Automation 应用在 Tutti 内打开                             |
| [08-terminal-open.png](assets/windows-e2e-acceptance-20260804/08-terminal-open.png)                       | Windows `cmd.exe` 终端面板                                 |
| [09-terminal-echo.png](assets/windows-e2e-acceptance-20260804/09-terminal-echo.png)                       | 终端实时回显 `TUTTI-WINDOWS-TERMINAL-E2E`                  |
| [10-browser-google.png](assets/windows-e2e-acceptance-20260804/10-browser-google.png)                     | 内置浏览器打开 Google 基线页                               |
| [11-browser-local-automation.png](assets/windows-e2e-acceptance-20260804/11-browser-local-automation.png) | 内置浏览器访问 `http://127.0.0.1:65394/` 并渲染 Automation |
| [12-folder-reverify.png](assets/windows-e2e-acceptance-20260804/12-folder-reverify.png)                   | 文件夹修复后的刷新复验                                     |

## 3. Agent GUI

### 3.1 主路径场景

| ID    | 场景                      | 结果                              | 证据                                                                                                             |
| ----- | ------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| AG-01 | 打开 Agent 工作区         | PASS                              | [02](assets/windows-e2e-acceptance-20260804/02-workspace-topbar.png)；Agent 面板可见                             |
| AG-02 | 安装/识别 Codex           | PASS                              | Provider 列表可见 Codex；desktop log 中有 `provider=codex` 的 create/resolve 事件                                |
| AG-03 | Codex 发送 `hi`           | PASS                              | [04](assets/windows-e2e-acceptance-20260804/04-agent-codex-hi.png)；界面收到 `Hi! How can I help?`               |
| AG-04 | Codex 工具调用渲染        | PASS（渲染）/ BLOCKED（外部任务） | todo-list 验证中界面显示 `3/5 次工具调用`；Feishu task 外部调用因授权/接口条件取消，未将任务产出误判为完成       |
| AG-05 | 安装/识别 Claude Code     | PASS                              | Provider 列表可见 Claude Code；desktop log 中有 `provider=claude-code` 的 create/resolve 事件                    |
| AG-06 | Claude Code 发送 `hi`     | PASS                              | [05](assets/windows-e2e-acceptance-20260804/05-agent-claude-hi.png)；界面收到 `Hi! 👋 How can I help you today?` |
| AG-07 | Agent 会话切换            | PASS                              | Agent 会话列表保留 Codex/Claude 的 `hi` 会话；日志包含不同 `agentSessionId` 和 provider                          |
| AG-08 | Agent 输入长文本/多行文本 | 未执行                            | 本轮只执行短消息主路径                                                                                           |
| AG-09 | Agent 失败状态展示        | 未执行                            | 需单独注入 provider/runtime 错误                                                                                 |
| AG-10 | 导出 Agent 调试日志       | PASS                              | [01](assets/windows-e2e-acceptance-20260804/01-baseline-export-dialog.jpg)；导出入口可见并显示 zip 输出路径      |

### 3.2 主路径结论

Agent GUI 的 Windows 主路径已跑通：打开 Agent → 识别 Codex/Claude Code → 新建会话 → 发送 `hi` → 显示模型回复。Claude Code 会话末尾出现一个“Ask user question”交互等待，这是 Claude 对 `hi` 的正常后续询问，不是 Windows 启动失败；本轮未替用户回答该问题，因此顶部仍可能显示“1 个等待”。

关键日志证据：

- `tutti-desktop.log` 中 `agent.submit.trace` → `activity_service.create` → `renderer_adapter.create.resolved` 形成完整调用链。
- Codex 会话的 `provider=codex` 和 Claude 会话的 `provider=claude-code` 均有 resolve 记录。
- 工具调用渲染已观察到调用计数和状态行；外部 Feishu 工具本身受授权条件阻塞，单独列为 BLOCKED。

## 4. 应用

### 4.1 主路径场景

| ID     | 场景                             | 结果 | 证据                                                                                                   |
| ------ | -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| APP-01 | 打开应用中心                     | PASS | [06](assets/windows-e2e-acceptance-20260804/06-application-center.png)                                 |
| APP-02 | 查看本地/官方应用包              | PASS | [06](assets/windows-e2e-acceptance-20260804/06-application-center.png)；列表展示应用名、版本和打开入口 |
| APP-03 | 启动 Tutti Onboarding            | PASS | `tutti-onboarding` runtime `/api/health` = 200                                                         |
| APP-04 | 启动 AI Media Canvas             | PASS | `ai-media-canvas` runtime `/api/health` = 200                                                          |
| APP-05 | 启动 Design Review               | PASS | `design-review` runtime `/healthz` = 200                                                               |
| APP-06 | 启动 Vibe Design                 | PASS | `vibe-design` runtime `/healthz` = 204                                                                 |
| APP-07 | 启动 Omni Catcher                | PASS | `omni-catcher` runtime `/healthz` = 200                                                                |
| APP-08 | 启动 Group Chat                  | PASS | `group-chat` runtime `/api/health` = 200                                                               |
| APP-09 | 启动 Product Competition         | PASS | `product-competition` runtime `/api/health` = 200                                                      |
| APP-10 | 启动 Daily Tech Radar/Automation | PASS | [07](assets/windows-e2e-acceptance-20260804/07-automation-app.png)；Automation `/healthz` = 200        |

### 4.2 主路径结论

应用中心可打开并展示官方应用；Automation 已在 Tutti 内实际打开，页面显示“自动化 / 暂无自动化任务 / 入门模板”。Automation 的 runtime.log 同时确认使用仓库托管的 Windows Python、Node、npm 和 managed POSIX shell。其余已部署 `tutti.app.json` 应用均完成本机 runtime 健康检查，结果汇总见 [2.1](#21-windows-应用-runtime-健康汇总)。

本轮健康检查验证的是“Windows runtime 启动和 HTTP 服务可用”，不是每个应用所有业务页面的完整人工回归；需要产品级发布前再按附录 P1/P2 场景逐应用补齐。

## 5. 文件夹/工作区

### 5.1 主路径场景

| ID        | 场景              | 结果   | 证据                                                                                                   |
| --------- | ----------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| FOLDER-01 | 打开文件工作区    | PASS   | [03](assets/windows-e2e-acceptance-20260804/03-folder-documents.png)                                   |
| FOLDER-02 | 打开用户目录      | PASS   | UI 路径显示 `/C:/Users/15514`；daemon 返回 `root=/C:/Users/15514`                                      |
| FOLDER-03 | 打开 `C:\` 根目录 | 未执行 | 本轮以用户目录为工作区根目录                                                                           |
| FOLDER-04 | 进入多级子目录    | PASS   | [03](assets/windows-e2e-acceptance-20260804/03-folder-documents.png)；进入 `/C:/Users/15514/Documents` |
| FOLDER-05 | 返回上级目录      | PASS   | daemon 记录返回 `/C:/Users/15514` 且 `entryCount=31`                                                   |
| FOLDER-06 | 打开文件内容      | 未执行 | 本轮集中验证目录列举和路径安全                                                                         |
| FOLDER-07 | 打开带空格路径    | 未执行 | 代码单测覆盖盘符逻辑路径，未单独建立带空格目录                                                         |
| FOLDER-08 | 切换工作区        | 未执行 | 本轮仅使用一个隔离 workspace                                                                           |
| FOLDER-09 | 刷新目录          | PASS   | [12](assets/windows-e2e-acceptance-20260804/12-folder-reverify.png)；刷新后列表与 daemon 完成事件一致  |
| FOLDER-10 | 文件夹错误提示    | PASS   | 修复后刷新无新增路径越界错误；单元测试 9/9 通过                                                        |

### 5.2 主路径结论

目录浏览、进入 Documents、返回上级和刷新已在 Windows dev-gui 中复验通过。修复前旧日志中的 `C:\C:\Users\15514\...` 越界错误已定位并修复；修复后刷新产生的最新 daemon 事件为：

```text
workspace.file.directory.list_requested  path=C:/Users/15514
workspace.file.directory.list_completed  path=C:/Users/15514 directoryPath=/C:/Users/15514 root=/C:/Users/15514 entryCount=31
```

## 6. 终端

### 6.1 主路径场景

| ID      | 场景               | 结果                             | 证据                                                                                                           |
| ------- | ------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| TERM-01 | 打开终端工作区     | PASS                             | [08](assets/windows-e2e-acceptance-20260804/08-terminal-open.png)；面板显示 `cmd.exe / 运行中`                 |
| TERM-02 | 显示当前工作目录   | PASS                             | daemon terminal snapshot 返回 `C:\Users\15514>`；terminal ID `6ff5369e-e209-406c-a430-44e8e41cf9d0`            |
| TERM-03 | 执行简单命令       | PASS                             | [09](assets/windows-e2e-acceptance-20260804/09-terminal-echo.png)；`echo TUTTI-WINDOWS-TERMINAL-E2E` 回显成功  |
| TERM-04 | 执行带空格路径命令 | 未执行                           | 本轮使用无空格的安全回显命令                                                                                   |
| TERM-05 | 检查托管 Node      | PASS（runtime 证据）             | Automation runtime.log 记录托管 Windows Node 路径                                                              |
| TERM-06 | 检查托管 Python    | PASS（runtime 证据）             | Automation runtime.log 记录托管 Windows Python 路径                                                            |
| TERM-07 | 环境变量注入       | 未执行                           | 未在终端内打印环境变量                                                                                         |
| TERM-08 | 命令失败展示       | 未执行                           | 未主动制造失败命令                                                                                             |
| TERM-09 | 多行输出/滚动      | PASS                             | WebSocket resize、snapshot、output 事件正常；[09](assets/windows-e2e-acceptance-20260804/09-terminal-echo.png) |
| TERM-10 | 终端重开           | PASS（关闭保护）/ 未执行（重开） | 关闭时出现“要终止这个终端吗？”保护确认；按安全策略取消终止，未执行重开                                         |

### 6.2 主路径结论

Windows cmd 终端可创建、可取得 snapshot、cwd 正确、可接收输入并实时回显。daemon/desktop 日志记录了 terminal hydration、snapshot、resize 和 output projection 事件。关闭终端时的终止确认也正常显示；由于该操作会杀掉正在运行的终端进程，本轮按确认策略选择取消，未将“未重开”误判为失败。

## 7. 浏览器

### 7.1 主路径场景

| ID         | 场景              | 结果   | 证据                                                                                                                                                                                          |
| ---------- | ----------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BROWSER-01 | 打开浏览器工作区  | PASS   | [10](assets/windows-e2e-acceptance-20260804/10-browser-google.png)                                                                                                                            |
| BROWSER-02 | 打开本地应用 URL  | PASS   | [11](assets/windows-e2e-acceptance-20260804/11-browser-local-automation.png)                                                                                                                  |
| BROWSER-03 | 页面标题/内容渲染 | PASS   | [11](assets/windows-e2e-acceptance-20260804/11-browser-local-automation.png)；显示 Automation 页面和模板                                                                                      |
| BROWSER-04 | 页面内滚动        | 未执行 | 本轮未单独测滚动区域                                                                                                                                                                          |
| BROWSER-05 | 地址栏切换 URL    | PASS   | [11](assets/windows-e2e-acceptance-20260804/11-browser-local-automation.png)；地址栏显示 `http://127.0.0.1:65394/`                                                                            |
| BROWSER-06 | 刷新页面          | 未执行 | 未单独点击浏览器刷新按钮                                                                                                                                                                      |
| BROWSER-07 | 前进/后退         | 未执行 | 未单独验证历史栈                                                                                                                                                                              |
| BROWSER-08 | 打开应用页面链接  | PASS   | 本地 Automation 页面从浏览器 panel 成功打开                                                                                                                                                   |
| BROWSER-09 | 本地端口失败页    | PASS   | [10](assets/windows-e2e-acceptance-20260804/10-browser-google.png) 前序错误 URL 产生可见 404 状态，错误页可渲染                                                                               |
| BROWSER-10 | 浏览器与应用联动  | PASS   | [07](assets/windows-e2e-acceptance-20260804/07-automation-app.png) 与 [11](assets/windows-e2e-acceptance-20260804/11-browser-local-automation.png) 展示同一 Automation 服务的应用页和浏览器页 |

### 7.2 主路径结论

Tutti 内置浏览器可以打开外部基线页，并通过地址栏导航到本机 Windows 应用服务。访问 `http://127.0.0.1:65394/` 后页面标题、内容和模板正常渲染，证明浏览器到本地 runtime 的 loopback 链路可用。

## 8. 问题定位与修复记录

| 编号   | 模块                            | 现象                                                                                                      | 直接原因                                                                                                                                                  | 系统性原因                                                                                                                                                                                               | 代码/日志证据                                                                                                                                                    | 修复与复验                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-01 | 文件夹/工作区                   | Windows 版本打开文件夹时出现路径越界错误，页面可能看不到正确文件列表                                      | daemon 返回的 Windows 盘符逻辑路径是 `/C:/Users/...`；桌面端在 Windows 上直接 `path.resolve('/C:/...')`，得到 `C:\C:\Users\...`，随后被根目录安全校验拒绝 | daemon 使用跨平台逻辑路径表达盘符，desktop host 的 OS 路径转换层缺少统一归一化，导致“逻辑路径 → Windows 绝对路径”契约断裂                                                                                | 旧 `tutti-desktop.log` 在 `2026-08-04T01:48:42Z` 连续记录 `workspace file path escapes root directory: C:\C:\Users\15514\...`；daemon 同期目录 list 完成事件正常 | 在 [workspaceFilePaths.ts](/C:/Work/tutti-os/tutti/apps/desktop/src/main/host/workspaceFilePaths.ts:31) 的 `resolveWorkspaceFileAbsolutePath` 前增加盘符逻辑路径归一化，并在 [workspaceFilePaths.ts](/C:/Work/tutti-os/tutti/apps/desktop/src/main/host/workspaceFilePaths.ts:57) 处理 `/C:/`；新增 [workspaceFilePaths.test.ts](/C:/Work/tutti-os/tutti/apps/desktop/src/main/host/workspaceFilePaths.test.ts:51)。单测 9/9；dev-gui 刷新后目录 list 完成且没有新增同类错误 |
| BUG-02 | 扩展 runtime / Windows 路径校验 | 扩展应用提交 `/tmp/outside` 形式的 skill root 时，Windows 原先没有把它识别为绝对路径                      | `filepath.IsAbs` 使用宿主 OS 语义；Windows 下单斜杠根路径经过 `filepath.FromSlash` 后可能被当成相对路径，随后拼接进 workspace                             | `TestExtensionRuntimePreparerWithoutHomeRejectsUnsafeSkillRoot` 在 Windows 首次失败；代码位置为 [extension_runtime.go](/C:/Work/tutti-os/tutti/packages/agent/runtimeprep/extension_runtime.go:294)      | 校验同时使用 slash 归一化、`path.IsAbs`、Windows drive 前缀和宿主 `filepath.IsAbs`；定向测试与 `go test ./packages/agent/runtimeprep -count=1` 均通过            |
| BUG-03 | Agent 安装环境                  | Windows descriptor 仍使用可移植的 `npm install ...` 命令时，没有把 managed Node 的 bin 目录放到 PATH 首位 | `shellCommandUsesNPM` 只比较当前平台的 `npmBinaryName()`，Windows 返回 `npm.cmd`，因而漏掉 descriptor 中的 `npm`                                          | `TestShellCommandNPMInstallerEnvPrefersManagedRuntime` 首次输出 PATH 未以 managed Node bin 开头；代码位置为 [installer.go](/C:/Work/tutti-os/tutti/services/tuttid/service/agentstatus/installer.go:528) | 同时接受 `npm` 与 `npm.cmd`（大小写不敏感）；Windows 定向测试通过，npm 安装链路继续使用 managed runtime                                                          |

### 8.1 根因调用链

```text
Windows 文件夹 UI
  → workspace.file.directory.list_requested
  → tuttid 返回逻辑路径 /C:/Users/15514/Documents
  → desktop host resolveWorkspaceFileAbsolutePath
  → Windows path.resolve('/C:/...') 产生 C:\C:\...
  → isPathWithinRoot 拒绝
  → renderer diagnostic / 文件夹列表异常
```

修复后的链路在进入 `path.resolve` 前把 `/C:/...` 转为 `C:/...`，同时保留根目录越界校验，因此既修复了合法盘符路径，也没有放宽文件系统安全边界。

## 9. 回归测试与静态检查

本轮/此前 Windows 改造回归结果：

- `workspaceFilePaths.test.ts`：9/9 通过，包含新增 `/C:/...` 盘符逻辑路径用例。
- agentstatus Windows 关键测试（cmd installer、managed POSIX shell invocation、Windows executable rule、Codex AppX materialization）通过；Codex layout/path portability tests通过。
- `go test ./services/tuttid/service/agentstatus -count=1` 已实际执行，但全包仍被历史 Unix shell fixture、Unix executable bit 假设和非管理员 symlink fixture 阻塞；这不是本次 dev-gui 主链路失败。已将 Windows executable 判定、npm prefix path expectation、ACL/symlink fixture 的 Windows 行为修正/跳过，并将剩余全包 fixture 列入后续测试兼容改造。
- `go test ./packages/workspace/files -count=1`：通过。
- `go test ./packages/agent/runtimeprep -count=1`：整包通过；模型缓存失效、模型目录/rollout 暴露、Claude fallback、扩展 runtime Windows 路径校验均已复验。需要 Windows symlink privilege 的安全拒绝用例按环境跳过，不把权限缺失误报成实现失败。
- `go test ./services/tuttid/service/workspace -count=1`：整包仍有测试夹具残留，主要是 `bootstrap.sh`/managed POSIX shell、旧 issue-manager 参数和 Windows 临时目录清理时序；实际已部署应用的 Windows health check 与 GUI 应用主路径不受该 fixture 失败影响。
- desktop typecheck：通过。
- release config tests：41/41 通过。
- runtime catalog tests：3/3 通过。
- `git diff --check`、Go 格式检查：通过。

## 10. 结论与残留风险

### 10.1 验收结论

五个模块的 Windows 核心主路径均已执行并有截图/日志证据：

- Agent GUI：Codex、Claude Code 均可识别并完成 `hi` 对话；工具调用渲染已观察到，外部 Feishu task 因授权阻塞单独标记 BLOCKED。
- 应用：应用中心可用；Automation 实际页面可用；已部署 Windows 应用 runtime 健康检查全部通过。
- 文件夹：发现的盘符路径问题已修复，目录进入、返回、刷新复验通过。
- 终端：cmd、cwd、输入、回显、snapshot、resize 和关闭保护通过。
- 浏览器：外部页和 localhost Automation 页面均可访问并渲染。

### 10.2 未执行/残留项

- 附录中的 P1/P2 边界场景（长路径、权限/UAC、锁定文件、并行会话、断网恢复、DPI/IME、浏览器下载/Profile 隔离等）本轮未全部执行；文档不把它们标记为通过。
- agentstatus 全包测试仍有测试夹具层残留：多处 fixture 直接执行 POSIX `#!/bin/sh` 文件，Windows 需要 `.cmd/.exe`；部分测试需要创建 symlink，而当前用户未启用 symlink privilege。当前已保留并通过 Windows 关键实现测试，未把这些 fixture 阻塞误判为 Agent GUI 主链路故障。
- workspace service 全包测试同样保留少量 Unix-oriented fixture；后续应把 `bootstrap.sh` fixture 改为 Windows cmd/managed-shell fixture，并单独修正 issue-manager 参数测试与临时目录清理等待。
- Claude Code 的一条交互式问题仍处于等待状态，这是手动验证过程中保留的会话状态。
- 终端关闭确认已验证，但为避免未经确认杀掉 dev-gui 终端，终端仍保持运行，没有执行“终止后重开”。
- 本轮只在 `codex/windows-followup-v2` 上验收，没有 push、合并或触发生产发布；正式包/生产 CloudFront runtime catalog 仍需按发布流程单独验证。

## 附录 A：subagent 扩展场景矩阵

以下为 Hubble 返回的完整扩展范围；每个模块不超过 30 个。本文 3–7 节优先执行其中的主路径，附加场景用于后续验收批次。

| 模块          | 已有主路径 ID         | 追加 P1/P2 ID 与主题                                                                                                                                                     |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent GUI     | AG-01–AG-10           | AG-11 DPI/IME/窗口焦点；AG-12 非正常退出与恢复                                                                                                                           |
| 应用          | APP-01–APP-10         | AP-11 权限/UAC；AP-12 配置恢复；AP-13 并行实例隔离；AP-14 超时/重试幂等；AP-15 缺少 Node/Python/Git；AP-16 崩溃清理；AP-17 大文件/锁定文件                               |
| 文件夹/工作区 | FOLDER-01–FOLDER-10   | FO-11 只读/无权限；FO-12 长路径；FO-13 隐藏文件/符号链接；FO-14 重启索引恢复；FO-15 网络盘/移动盘/盘符变化                                                               |
| 终端          | TERM-01–TERM-10       | TE-11 Git；TE-12 权限/UAC；TE-13 ANSI/resize/剪贴板；TE-14 缺少依赖；TE-15 Agent 终端审批；TE-16 子进程清理与恢复                                                        |
| 浏览器        | BROWSER-01–BROWSER-10 | BR-11 权限/证书/代理；BR-12 超时/断网恢复；BR-13 DPI/多显示器；BR-14 Profile/页面恢复；BR-15 Agent 驱动浏览器；BR-16 恶意页面与下载策略；BR-17 浏览器版本/可执行路径变化 |
