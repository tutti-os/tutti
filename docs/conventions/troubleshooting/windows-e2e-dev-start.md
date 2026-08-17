# Windows E2E Dev 启动约定

## 一条命令启动

在仓库根目录执行：

```powershell
& .\tools\scripts\start-windows-e2e-dev.ps1 `
  -RepoRoot C:\Work\tutti-os\tutti-windows-e2e-acceptance-20260804 `
  -ResetState
```

在当前仓库根目录，也可以使用固定版本的 pnpm 命令：

```powershell
corepack pnpm@10.11.0 dev:windows:e2e:clean  # 首次启动或需要清理旧状态
corepack pnpm@10.11.0 dev:windows:e2e        # 后续复用已有状态
```

不要给 pnpm script 追加 `-- -ResetState`；需要自定义 `RepoRoot` 或 `StateDir` 时，直接调用上面的 PowerShell 脚本。

这个入口默认不重新 build。它会完成以下前置检查并按固定顺序启动：

1. 校验 Node 主版本和 `corepack pnpm` 版本；
2. 校验已经构建的 `tuttid.exe`、Electron 入口和 Windows 内置
   `managed-posix-shell/runtime.json`；
3. 从 runtime metadata 解析并注入
   `TUTTI_MANAGED_POSIX_SHELL`；
4. 强制设置 `TUTTI_ANALYTICS_DISABLED=1`，避免验收操作进入业务埋点；
5. 启动或复用 `http://127.0.0.1:5173` 的 renderer dev server；
6. 从 `apps/desktop` 目录启动 Electron，并让桌面进程自己生成临时
   `TUTTID_ACCESS_TOKEN`；
7. 等待 `tutti-desktop.log` 出现 `desktop app ready` 后才返回成功。

默认 state 在仓库 `.tmp\tutti-windows-e2e-dev` 下。需要完全干净的验收时使用
`-ResetState`；脚本只允许清理仓库 `.tmp` 下的 state，并且会先关闭同一
worktree/state 的开发进程，避免 app server 锁住旧的 `.exe`。

## 为什么之前会反复遇到“应用安装不上”

日志显示“下载安装”和“启动失败”曾被混在一起看：

- `tuttid.log` 的 `18:07:29` 开始下载 `ai-slide`，`18:07:40` 下载完成，
  `18:07:45` 记录 `workspace_app_install_job_succeeded`；
- `18:19:03` 开始下载 `ai-media-canvas`，`18:19:41` 下载完成，
  `18:20:10` 记录 `workspace_app_install_job_succeeded`，随后
  `18:20:14` 记录 `workspace_app_runtime_running`；
- 真正的失败日志是 `workspace_app_runtime_start_failed`，原因明确为：
  `managed POSIX shell is unavailable on Windows: TUTTI_MANAGED_POSIX_SHELL is not configured`；
- 同一 state 反复启动时还出现 `workspace.app.package.replace_deferred`，
  错误为 `tutti-onboarding-server.exe: Access is denied`。这是旧 app server
  仍在运行导致的文件锁，不是远端包下载失败。

因此，Windows 开发验收不能只运行裸的 `tuttid.exe`，也不能只设置
`TUTTID_ACCESS_TOKEN`：裸 daemon 缺少桌面注入的临时 token，且不会自动知道
仓库内置的 managed shell；也不能复用仍有 app server 子进程的旧 state。

## 常见错误与处理

| 现象                                    | 原因                                            | 处理                                         |
| --------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| `TUTTID_ACCESS_TOKEN is required`       | 直接启动 daemon，绕过 Electron 的桌面托管       | 使用本脚本，不要手工运行 `tuttid.exe`        |
| `managed POSIX shell is unavailable...` | 未注入仓库内置 Bash                             | 检查脚本输出的 `shell` 路径和 `runtime.json` |
| `Access is denied` 替换 app server      | 旧 state 的 app runtime 仍被进程占用            | 脚本会清理同一 state；必要时加 `-ResetState` |
| `Cannot find module <repo-root>`        | Electron 的 cwd 是仓库根，而不是 `apps/desktop` | 由脚本固定在 `apps/desktop` 启动             |
| `ERR_PNPM_UNSUPPORTED_ENGINE`           | 系统 pnpm 不是仓库要求版本                      | 脚本固定使用 `corepack pnpm`                 |

## 验收前检查日志

启动成功后重点看：

```powershell
$state = 'C:\Work\tutti-os\tutti-windows-e2e-acceptance-20260804\.tmp\tutti-windows-e2e-dev'
Select-String -Path "$state\logs\tutti-desktop.log" -Pattern 'desktop app ready|managed_posix_shell'
Select-String -Path "$state\logs\tuttid.log" -Pattern 'workspace_app_install_job_succeeded|workspace_app_runtime_running|workspace_app_runtime_start_failed'
```

期望看到 `desktop app ready`、安装成功和 `workspace_app_runtime_running`；
若再次出现 `managed_posix_shell` 未配置，应先停止验收，不要继续重复点击“安装”。
