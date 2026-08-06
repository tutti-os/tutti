# Windows E2E 开发构建约定

Windows E2E 验收只需要 `services/tuttid` 的 `tuttid.exe`、renderer dev server 和 managed POSIX shell，不需要执行发布构建的全部阶段。

## 快速构建

在仓库根目录执行：

```powershell
corepack pnpm@10.11.0 build:windows:e2e
```

这个命令：

- 使用固定输出路径 `apps/desktop/build/tuttid/tuttid-dev.exe`，让 Go build cache 和增量链接生效；
- 不覆盖可能仍被旧实例占用的发布副本 `tuttid.exe`；启动脚本会优先使用这个开发副本；
- 只有 builtin app 源文件比已生成 zip 更新时才重新打包 builtin app；
- 只编译 `services/tuttid`，默认不编译 CLI；
- 不运行单测、类型检查、lint 或 Electron 打包。

如果确实需要 builtin app 重新生成：

```powershell
corepack pnpm@10.11.0 build:windows:e2e -- -ForceBuiltinApps
```

构建前需要先关闭当前 Windows E2E Dev。构建完成后使用：

```powershell
corepack pnpm@10.11.0 dev:windows:e2e
```

首次安装依赖、修改 builtin app 或需要完整发布包时，仍使用仓库原有的 `pnpm build` / Electron 打包入口；本命令只服务于本地 Windows E2E 快速迭代。
