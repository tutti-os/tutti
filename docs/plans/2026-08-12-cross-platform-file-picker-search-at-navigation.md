# 跨平台文件 Picker 搜索与 @ 面板导航改造方案

> 状态：已确认范围，代码已实现、待最终验收。仓库：tutti（本次没有拆分出的第二个仓库）。
> Windows Search 已在当前 Windows 开发机验证；目标发行环境与 macOS 权限/索引服务仍需实机确认。

## 结论

统一解决三个用户可见问题：Windows 与 macOS 文件搜索不再走 renderer/daemon 的全量递归扫描，Windows 隐藏“最近访问”入口，并修复 @ 面板点击文件夹箭头后无法进入下一层的问题。

## 1. 背景与目标

工作区文件管理器和 rich-text/AgentGUI 的 @ 引用面板，最终都依赖 tuttid 的 /files/search、/files/directory 和 /files/recent。

目标：

- macOS、Windows 的关键词搜索和文件类型筛选统一走后端 Search，再由平台 Adapter 调用系统索引。
- 正常产品路径退出 os.ReadDir 递归搜索；不新增旧扫描器 fallback。索引不可用时快速失败并留下可观测错误，具体 UI 文案待确认。
- Windows 不生成 local:recent location；已有持久化选择自动回到仍存在的位置。
- Agent @ 面板目录箭头和键盘层级导航共用状态更新；从搜索结果进入目录时，编辑器查询词与目录浏览状态同步切换。
- 不改变公开 HTTP 请求/响应结构，不增加 preload 通道。

## 2. 当前架构和完整链路

### 文件管理器

用户输入关键词/筛选
-> workspace-file-manager Session.search
-> DesktopWorkspaceFileReferenceAdapter.searchReferences
-> TuttidClient.searchWorkspaceFiles
-> daemon SearchWorkspaceFiles
-> workspace Service.Search
-> LocalFilesAdapter.Search
-> os.ReadDir 队列递归 + 候选上限/deadline/忽略目录
-> ScoreSearchCandidates 或 BuildListingEntries
-> renderer 展示结果

SearchInput 已支持 query、filters、includeKinds、within 和 limit，但 LocalFilesAdapter.Search 直接遍历物理目录，结果受遍历顺序、候选上限和 deadline 影响。

### @ 面板

输入 @ / 选择位置 / 选择筛选
-> ReferenceSourcePickerController
-> ReferenceSourceAggregator.search
-> workspace file location source
-> DesktopWorkspaceFileReferenceAdapter
-> 上面的 /files/search 链路

Agent Composer 输入 `@关键词`
-> agentFileMentionExtension 生成 suggestion
-> useComposerPresentation 调用 AgentMentionSearchController.updateQuery
-> 文件 Provider 通过既有 workspace file reference Search 返回文件和文件夹
-> AgentFileMentionPalette / MentionRow 渲染文件夹箭头
-> useComposerMentionActions.navigateIntoFileMentionItem
-> AgentMentionSearchController.selectFileMentionNavigationItem

已确认直接原因不是失焦：MentionRow 已阻止箭头的默认 focus/bubble，实际控制器在 `currentQuery` 非空时直接返回 `false`，所以点击回调虽然执行，却不会进入目录。若只删除该判断，编辑器仍保留 `@关键词`，下一次 suggestion 更新又会把控制器重置回搜索态，因此必须先同步清空查询词和控制器 query，再进入目录。

另一个独立问题是本地 source 没有打开 filtersUseSearch：无关键词筛选会在 picker 侧递归 listChildren 后再投影，从而重新触碰大量目录。

## 3. 目标架构和完整链路

Picker / @ 面板
-> 现有 SearchInput（query + filters + kinds + within）
-> daemon FileService / workspace Service
-> LocalFilesAdapter.Search
-> PlatformFileSearchAdapter（按 GOOS 选择）
Windows：Windows Search SystemIndex Adapter
macOS：Spotlight mdfind Adapter
其他系统：保持现有非目标能力，策略待确认
-> 统一路径/类型/隐藏项过滤 + 现有结果映射
-> SearchResult -> renderer

平台命令/API 只存在 services/tuttid/data/workspace 的 build-tag 文件。通用层只依赖窄接口：输入物理 root、within、query、kind/filter、limit，输出物理路径；kind 和隐藏项由通用层用文件元数据二次确认。索引查询失败不转回旧递归扫描；返回明确错误并记录平台、耗时、索引不可用原因。

## 4. 每个仓库、服务、模块改什么

本次只有一个 Git 仓库 tutti，相关模块如下。

| 模块/文件                                                                             | 改动                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| services/tuttid/data/workspace/local_files.go                                         | LocalFilesAdapter 增加内部搜索 Provider 依赖；目录读写、recent、preview 保持不变。测试可注入 fake Provider，生产默认不能回到递归扫描。                             |
| services/tuttid/data/workspace/local_files_search.go                                  | 保留请求归一、物理路径校验、类型/隐藏项过滤、结果映射和日志；删除生产调用的递归候选收集。                                                                          |
| services/tuttid/data/workspace/local_files_search_windows.go                          | Windows build-tag Adapter：查询 Windows Search SystemIndex，安全传递 PowerShell 参数，处理取消、deadline、命令失败和输出解析。SQL 字段/PowerShell 版本需实机确认。 |
| services/tuttid/data/workspace/local_files_search_darwin.go                           | macOS build-tag Adapter：用 Spotlight mdfind 查询名称/路径，做 root containment、类型、隐藏项和 filter 过滤；复用现有 mdfind 进程调用模式。                        |
| services/tuttid/data/workspace/local_files_search_other.go                            | 非目标平台不得偷偷使用旧递归搜索；可返回“平台搜索不可用”，Linux 策略待确认。                                                                                       |
| services/tuttid/data/workspace/local_files_search_test_provider_test.go、平台测试文件 | 覆盖 Provider 输入映射、路径越界、类型/隐藏、取消、Windows SQL/URL 输出解析和错误；临时目录测试改成显式 fake Provider。                                            |
| apps/desktop/.../workspaceFileReferenceSource.ts                                      | 本地 source 声明 filtersUseSearch: true，使无关键词筛选直接调用既有 Search。                                                                                       |
| apps/desktop/.../workspaceFileLocationReferenceSources.ts                             | 项目位置和本地位置 source 都声明 filtersUseSearch: true；Recent 仍走自己的列表过滤。                                                                               |
| apps/desktop/.../desktopWorkspaceFileLocations.ts                                     | buildLocalLocations 接收平台；Windows 排除 local:recent，macOS 保持。                                                                                              |
| apps/desktop/.../workspaceFileManagerService.ts、AgentGUI host                        | 传递已有 platformApi.os 给 location builder，不增加 preload 字段。                                                                                                 |
| apps/desktop/.../workspaceFileManagerService.test.ts 与 source tests                  | 覆盖 Windows 无 recent、macOS 有 recent、旧 local:recent 持久化选择回退，以及两类位置均走 Search。                                                                 |
| packages/agent/gui/.../composer/useComposerMentionActions.ts                          | 从搜索结果进入 workspace 文件夹前，将活动的 `@关键词` 替换成 `@`，并让点击、Enter、ArrowRight 共用同一入口。                                                       |
| packages/agent/gui/.../AgentMentionSearchController.ts                                | 目录浏览中忽略同 workspace/context 的重复空查询更新，避免 suggestion effect 把刚进入的目录重置到根目录。                                                           |
| packages/agent/gui/.../AgentMentionSearchController.spec.ts                           | 覆盖“搜索命中文件夹 -> 清空查询 -> 进入目录 -> 重复空查询不重置”的完整状态转换。                                                                                   |
| docs/plans/2026-08-12-cross-platform-file-picker-search-at-navigation.md              | 固化背景、链路、边界、迁移、风险、验收和实施顺序。                                                                                                                 |

### 接口变化

不新增公开 HTTP endpoint、请求字段、响应字段、IPC/preload 方法。SearchInput 已有 query、filters、includeKinds、within 和 limit。新增的仅是服务内部 Adapter 接口/构造依赖。

## 5. 可复用部分与 Adapter 边界

可复用：

- workspace Service.Search 的参数归一、根路径解析和错误出口；
- SearchInput、SearchEntry 及现有结果映射；
- Recent 的 macOS mdfind 超时/输出读取模式；
- Picker 的 filtersUseSearch、source registry、limit/abort 机制；
- MentionRow 的箭头视觉、阻止失焦行为和键盘导航协议。

Adapter 只负责系统索引查询、平台命令/API 生命周期、原始路径解析和平台错误。Adapter 不负责 renderer 状态、不拼接 mention://、不决定 source/tab 展示、不改变公开协议。

## 6. 明确不做

- 不保留 Windows/macOS 正常搜索的旧 os.ReadDir 递归 fallback。
- 不新增自建全文索引、数据库 schema、后台索引任务或文件内容搜索。
- 不把 Recent 的访问时间语义改成普通关键词搜索；Windows 只隐藏入口，macOS 保持现有 Spotlight Recent。
- 不重做右上角按钮/整套 Picker UI，不改变打开、预览、上传、删除能力。
- 不处理尚未确认的 Linux 索引策略，也不把未实机确认的命令可用性写成事实。

## 7. 数据迁移和兼容策略

- 无数据库、HTTP schema 或 preload 迁移。
- workspace file manager 持久化 schema 不变；Windows 读到旧 local:recent 时使用现有 location resolver 选择有效位置，具体优先顺序以现有 resolver 测试确认。
- macOS location id 保持 local:recent；Windows 新会话不产生该 id。
- 索引只覆盖系统已索引位置，结果可能少于旧递归扫描；索引覆盖范围和 UI 提示方案待确认。

## 8. 风险和回滚

| 风险                                                             | 控制/回滚                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Windows Search 未启动、位置未索引、PowerShell/AppLocker 策略拦截 | Adapter 快速报错并记录日志；发布前 Windows E2E 验证。回滚为恢复上一版本代码，不启用旧慢扫描。 |
| Spotlight 权限/索引异常                                          | macOS E2E 验证并保留错误日志；普通 Search 是否展示错误/空结果待确认。                         |
| 系统索引路径或类型误判                                           | root containment、os.Stat/metadata 二次确认，覆盖空格和 Unicode 路径。                        |
| 系统索引候选上限后再做隐藏项/元数据校验，可能不足 limit          | 平台查询尽量下推 query/filter，再做通用层校验；记录候选/跳过数并补多目录、多类型测试。        |
| Agent @ 面板编辑器/控制器状态不同步                              | 查询替换成功后同步清空 controller query；只忽略同 context 下目录浏览中的重复空查询。          |

回滚粒度：平台搜索、Windows location、Agent @ 导航、source capability 可分别 revert；公开协议无变化，不需要数据回滚。

## 9. 测试和验收标准

- Go：平台 Adapter/fake Adapter 单测、路径 containment、query/filter/kind/hidden/within/limit、取消、命令解析和错误日志。
- file-reference：query 为空且 filters 非空时调用 source search。
- desktop：Windows location 不含 local:recent，macOS 含；旧 persisted id 能落到有效 location。
- Agent GUI：控制器覆盖搜索命中文件夹后清空 query 并进入目录；Composer 覆盖将 `@关键词` 替换成 `@` 后再发起导航。
- 先执行 pnpm check:changed -- --dry-run，再执行覆盖变更能力的 pnpm check:changed；Go/UI 变更补跑对应定向测试和 typecheck。
- Windows E2E：已索引/未索引目录、文件/文件夹/type filter、取消、未触发全量递归日志、Recent 隐藏和旧选择回退。
- macOS E2E：Spotlight 关键词/type filter/within、Unicode/空格路径、Recent 继续按原链路显示。
- @ E2E：本地位置、点击箭头、返回、ArrowRight/ArrowLeft、点击外部关闭。

索引不可用时的产品文案和是否引导用户启用索引仍待确认；代码先保证快速失败和日志证据。

## 10. 分阶段实施顺序

1. 从最新 origin/main worktree 记录基线测试和当前 @ 回归结果。
2. 提交本方案文档，锁定不新增公开接口、不保留旧扫描 fallback。
3. 后端抽内部 Adapter，接入 Windows SystemIndex/macOS Spotlight，补测试和日志。
4. 打开两个本地 source 的 filtersUseSearch，Windows 隐藏 Recent，补持久化回退测试。
5. 修复 Agent @ 编辑器查询与目录控制器状态同步，补点击与键盘共用入口及控制器回归测试。
6. 运行变更检查、Go/TS 类型与单测，执行当前机器可执行的 E2E，并把不可确认项标出。
7. 由独立 subagent 只读 review diff、链路、风险和测试证据；修复后重新验证。
8. git commit -s、push 分支、创建 ready-for-review PR/MR，回读地址、描述和 CI 状态。

## 11. 待确认项

- Windows 发行包使用 Windows PowerShell 5.1 还是 PowerShell 7；Search.CollatorDSO 在目标系统的可用性和字段需实机确认。
- macOS 沙箱/权限下 mdfind 是否能查询用户选择的所有 workspace root。
- Windows/Linux 是否需要 Recent 的替代入口；本方案只落实 Windows 隐藏。
- 索引不可用时显示错误、空结果还是引导启用索引，需产品确认。
