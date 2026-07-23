import type { TranslationDictionary } from "../core/resources.ts";

export const zhCN = {
  browser: {
    chromeImportNotification: {
      completed: "已从 Chrome 导入 {{imported}} 项 Cookie",
      failed: "Chrome Cookie 导入未完成",
      partial: "已从 Chrome 导入 {{imported}} 项 Cookie，部分条目被跳过或失败",
      title: "Chrome 登录状态导入"
    }
  },
  common: {
    cancel: "取消",
    close: "关闭",
    defaultWorkspace: "默认空间",
    loading: "加载中",
    neverOpened: "从未打开",
    ok: "好",
    selectFolder: "选择文件夹",
    unknownError: "未知错误",
    unreachable: "不可达",
    workspace: "工作区",
    zipArchive: "ZIP 压缩包"
  },
  dashboard: {
    chooseWorkspaceTitle: "选择一个工作区",
    chooseWorkspaceDescription: "选择一个工作区继续",
    createWorkspace: "创建工作区",
    creatingWorkspace: "正在创建...",
    desktopFirstWorkflowDescription:
      "Renderer 状态保持为展示层，工作区生命周期仍通过 preload 和 tuttid 流转。",
    desktopFirstWorkflowTitle: "桌面优先工作流",
    emptyDescription: "创建一个工作区后，Tutti 会立即打开工作区窗口。",
    emptyTitle: "还没有工作区",
    launcherBadge: "工作区",
    launcherDescription:
      "打开一个工作区，继续上次的进度。工作区页面保持轻量，持久状态仍由 daemon 托管。",
    layeringDescription:
      "这个工作区页面刻意保持窄边界，后续更丰富的工作区能力仍会放在主窗口里。",
    layeringTitle: "为模块分层做好准备",
    newWorkspacePrompt: "想新建一个工作区？直接在这里创建即可。",
    recentWorkspaces: "最近工作区",
    readyStatus: "已就绪 {{count}} 个",
    restoreStateNote: "工作区从本地状态恢复，而不是在 renderer 里重新推导。",
    syncingStatus: "同步中",
    uiSystemNote:
      "新的 UI system 现在统一承载 tokens、icons 和共享 primitives。",
    welcomeDescription:
      "本地优先的智能生产力平台，为你的工作流提供掌控与专注。",
    welcomeTitle: "欢迎使用 Tutti",
    featureLocalTitle: "数据本地存储",
    featureLocalDescription: "隐私与安全由你掌控",
    featurePerformanceTitle: "本地高性能",
    featurePerformanceDescription: "快速响应，流畅体验",
    featureExtensibleTitle: "可扩展生态",
    featureExtensibleDescription: "灵活集成，持续进化",
    workspaceCountNote: "当前记录了 {{count}} 个最近工作区"
  },
  updates: {
    availableTitle: "发现可用新版本",
    badge: "更新",
    checkingTitle: "正在检查更新",
    downloadAction: "下载更新",
    downloadedTitle: "更新完成，立即安装",
    downloadingTitle: "正在下载 {{percent}}",
    errorTitle: "无法检查更新",
    restartAction: "重启安装",
    retryAction: "重试"
  },
  desktop: {
    installGuard: {
      detail:
        "Tutti 正在从下载的磁盘镜像中运行。请先移动到 Applications，再继续使用，这样后续更新才能正常安装。",
      failureDetail:
        "macOS 无法自动移动 Tutti。请将 {{appPath}} 拖到 Applications，然后从 Applications 打开 Tutti。",
      failureMessage: "请手动移动 Tutti",
      message: "要将 Tutti 移动到 Applications 吗？",
      moveAction: "移动到 Applications 并重新打开",
      quitAction: "退出",
      showInFinderAction: "在 Finder 中显示",
      title: "安装 Tutti"
    },
    logsExport: {
      actionHint: "你可以复制 Agent 调试指令，或打开导出文件所在目录。",
      agentPrompt: {
        archivePath: "日志压缩包：{{filePath}}",
        downloadDirectory: "下载目录：{{downloadDirectory}}",
        intro:
          "我刚导出了一份 Tutti 日志包，请帮我分析出现了什么问题，并帮我做修复。",
        stepEvidence: "2. 明确说明你的判断依据，并指出对应日志或证据。",
        stepFixPlan: "3. 给出最小且安全的修复方案。",
        stepImplement:
          "4. 如果需要改代码或配置，请直接实现修复，并解释改了什么、为什么这样改。",
        stepInspect:
          "1. 先查看日志包里的 runtime-context、export-summary 和日志文件，概括最可能的问题。",
        stepsHeader: "请按下面的顺序处理："
      },
      copyAgentPrompt: "复制 Agent Prompt",
      ok: "好的",
      openFolder: "打开目录",
      savedTitle: "日志已保存",
      savedTo: "已保存 {{count}} 个日志文件到：",
      title: "导出日志"
    },
    menu: {
      checkForUpdates: "检查更新...",
      clearLogsCompletedDetail: "已清除 {{count}} 个日志文件。",
      clearLogsCompletedMessage: "服务日志已清除。",
      clearLogsFailed: "无法清除日志",
      clearLogsTitle: "清除日志",
      clearServiceLogs: "清除服务日志...",
      edit: "编辑",
      exportLogsFailed: "无法导出日志",
      exportLogsTitle: "导出日志",
      exportRecentTenMinutesLogs: "最近 10 分钟",
      exportRecentThreeDaysLogs: "最近 3 天",
      exportServiceLogs: "导出服务日志",
      file: "文件",
      help: "帮助",
      logsOnly: "仅日志",
      logsWithAgentSessions: "日志 + Session 记录",
      openPerfMonitor: "打开 Perf Monitor DevTools",
      quit: "退出 Tutti",
      upToDateDetail: "Tutti {{version}} 是当前的最新版本。",
      upToDateMessage: "您使用的就是最新版本！",
      view: "显示",
      window: "窗口"
    },
    quitShortcut: {
      confirmToastTitle: "再次敲击 Command + Q 即可退出Tutti"
    }
  },
  workspace: {
    fallback: {
      loadingDescription: "正在通过桌面桥接恢复你的工作区上下文。",
      loadingTitle: "正在加载工作区",
      missingContextDescription:
        "这个窗口打开时没有携带工作区目标。请从工作区页面重新打开一个工作区。",
      missingContextTitle: "缺少工作区上下文",
      retryAction: "重试",
      unavailableTitle: "工作区当前不可用"
    },
    chrome: {
      currentWorkspace: "当前工作区",
      deleteFailed: "无法删除工作区。",
      openWorkspaceFailed: "无法打开工作区。",
      renameFailed: "无法重命名工作区。",
      switchWorkspace: "切换工作区",
      switchWorkspaceUnavailable: "暂时无法加载工作区列表。"
    },
    agentGui: {
      collapseConversationRail: "隐藏侧边栏",
      expandConversationRail: "显示侧边栏",
      fallbackAgentLabel: "Agent",
      newConversation: "新建会话",
      openNewWindow: "打开新窗口",
      untitledConversation: "未命名对话",
      openSessionUnavailableDescription: "这个 Agent 会话已不存在或无法打开。",
      openSessionUnavailableTitle: "会话不可用",
      sessionMenu: {
        copyAsMarkdown: "复制为 Markdown",
        copyAsReference: "复制为引用",
        moreActions: "更多会话操作",
        rename: "重命名会话"
      },
      browserElementContext: {
        cancel: "取消选择元素",
        failed: "无法将这个页面元素添加到 Agent 输入框",
        select: "选择页面元素"
      },
      toolSidebar: {
        apps: "应用",
        browser: "浏览器",
        close: "关闭",
        closeRightPanel: "收起右侧面板",
        expandPanel: "扩大面板",
        files: "文件",
        messages: "消息",
        newTab: "新建面板标签",
        openRightPanel: "展开右侧面板",
        resizeSidebar: "调整工具侧栏宽度",
        shrinkPanel: "缩小面板",
        tasks: "任务",
        terminal: "终端",
        tool: "工具",
        unavailable: "Agent 独立窗口暂未接入{{tool}}。"
      }
    },
    accountMenu: {
      title: "Tutti Agent",
      member: "管理订阅",
      creditsBalance: "积分余额",
      accountCenter: "账户设置",
      free: "Free",
      signIn: "登录",
      signOut: "退出登录",
      loading: "加载中",
      unavailable: "--",
      dataUnavailable: "部分账号数据暂不可用",
      rewardToastTitle: "新用户积分",
      rewardToastCreditsUnit: "积分",
      rewardToastDescription: "已添加到账户余额",
      rewardToastClose: "关闭积分奖励通知"
    },
    agentEnv: {
      configTitle: "{{provider}} 环境",
      wizardDescription:
        "Tutti 将检测、安装并校验 {{provider}}，使其可以运行。",
      configDescription:
        "{{provider}} 已就绪。可在此重新检测，管理版本、登录与安装。",
      phaseDetect: "检测",
      phaseInstall: "安装 / 修复",
      phaseVerify: "复检",
      detecting: "正在检测 {{provider}} 环境…",
      ready: "{{provider}} 已就绪。",
      busyInstalling: "正在设置 {{provider}}…",
      busyUpdating: "正在更新 {{provider}}…",
      busyVerifying: "正在校验 {{provider}}…",
      actionDetect: "重新检测",
      redetectDisabledInstalling: "安装进行中，暂时无法重新检测",
      redetectDisabledChecking: "正在检测…",
      actionInstall: "安装",
      actionRepair: "修复安装",
      actionUpgrade: "升级",
      actionUpdate: "更新",
      actionUpdating: "更新中…",
      actionRelogin: "重新登录",
      actionLogin: "登录",
      actionRetry: "重试",
      stepCli: "{{provider}} CLI",
      stepVersion: "受支持的版本",
      stepAuth: "已登录",
      stepRuntime: "运行环境就绪",
      logToggle: "安装日志",
      registryLabel: "镜像源",
      manualTitle: "想自己安装？",
      manualDescription: "在终端运行以下命令，然后重新检测：",
      manualCopy: "复制命令",
      manualCopied: "已复制",
      fieldVersion: "版本",
      fieldPath: "CLI 路径",
      fieldTargetNode: "目标 node",
      fieldAccount: "登录账号",
      fieldRegistry: "镜像源偏好",
      valueUnknown: "未知",
      valueNotInstalled: "未安装",
      valueNotSignedIn: "未登录",
      valueSignedIn: "已登录",
      registryPreferenceOfficial: "官方源 (npm)",
      registryPreferenceMirror: "镜像源",
      actionFailed: "该步骤失败。请查看日志后重试。",
      providerUnsupported: "该智能体暂不支持托管环境设置。",
      stageDetect: "检测环境",
      stageNetwork: "网络检测",
      stageDetectDone: "已检测环境",
      stageNetworkDone: "已检测网络",
      stageInstallDone: "已安装 CLI",
      stageAdapterDone: "已安装适配器",
      stageLoginDone: "已登录账号",
      stageLoginDoneApiBilling: "已配置 API 计费",
      stageReadyDone: "已就绪",
      networkCheckRegistry: "安装源",
      networkCheckApi: "服务接口",
      networkCheckProxy: "代理",
      networkProxyNone: "未配置（直连）",
      networkUnreachable: "无法连接",
      stageInstall: "安装 CLI",
      stageAdapter: "安装适配器",
      stageLogin: "登录账号",
      stageReady: "就绪",
      stageRetry: "重试",
      setupRemaining: "检测完成，请完成以下步骤以启用 {{provider}}。",
      stageProblemNetworkUnreachable: "无法连接网络",
      stageProblemInstallMissing: "未安装 {{provider}} CLI",
      stageProblemInstallOutdated: "{{provider}} CLI 版本不受支持",
      stageProblemInstallPlatformIncomplete: "{{provider}} 平台二进制包缺失",
      stageInstallVersionRequirement: "当前 {{current}} · 需要 ≥ {{required}}",
      stageAdapterVersionRequirement: "当前 {{current}} · 需要 ≥ {{required}}",
      stageProblemAdapterMissing: "未安装适配器",
      stageProblemAdapterMismatch: "适配器版本不受支持",
      stageProblemLoginMissing: "未登录",
      stageDoInstall: "进行安装",
      stageDoUpgrade: "进行升级",
      stageDoRepair: "修复安装",
      stageDoLogin: "进行登录",
      stageDoRedetect: "重新检测",
      reportConsentTitle: "检测到环境异常",
      reportConsentBody:
        "将上报更完整的诊断信息（CLI 路径、端点、代理地址、错误详情）以帮助排查。是否上报？可随时在「设置 → 通用」中更改。",
      reportConsentAgree: "同意并上报",
      reportConsentCancel: "暂不"
    },
    referenceSources: {
      appSourceLabel: "应用",
      issueSourceLabel: "任务",
      localSourceLabel: "本地",
      projectSourceLabel: "项目",
      sidebarDesktop: "桌面",
      sidebarDocuments: "文稿",
      sidebarDownloads: "下载",
      sidebarPersonal: "个人",
      sidebarRecent: "最近访问"
    },
    agentMessageCenter: {
      openAria: "打开 Agent 消息",
      promptConstraintHeader: "约束",
      promptInputHeader: "输入",
      promptQuestion: "为 Agent 添加回复。",
      promptTitle: "等待输入",
      title: "Agent 消息",
      idleStatus: "空闲中",
      outcomeNotificationCompletedBody: "Agent 已完成本次运行，点击查看会话。",
      outcomeNotificationCompletedStatus: "已完成",
      outcomeNotificationCompletedTitle: "{{title}} 已完成",
      outcomeNotificationFailedBody: "Agent 本次运行失败，点击查看会话。",
      outcomeNotificationFailedStatus: "运行失败",
      outcomeNotificationFailedTitle: "{{title}} 运行失败",
      waitingNotificationAction: "去处理",
      waitingNotificationCommand: "命令",
      waitingNotificationConversationPrefix: "会话：",
      waitingNotificationDescription:
        "{{title}} 正在 Agent 消息中等待你的决策。",
      waitingNotificationPlanAcceptEdits: "接受编辑",
      waitingNotificationPlanAllowAll: "全部允许",
      waitingNotificationPlanAskFirst: "逐次确认",
      waitingNotificationStatus: "等待中",
      waitingNotificationTitle: "{{title}} 需要你决策",
      runningCount: "{{count}} 个运行中",
      waitingCount: "{{count}} 个等待"
    },
    feedbackGroup: {
      instruction: "请使用微信扫码",
      qrAlt: "反馈群二维码",
      trigger: "加入反馈群",
      triggerAria: "加入反馈群"
    },
    externalImport: {
      archiveEmpty: "这个 Claude 导出中没有找到受支持的对话",
      archiveGroupLabel: "Claude 对话",
      archiveOptionDescription: "选择从 Claude 数据导出中下载的 ZIP 文件",
      archiveOptionTitle: "Claude 导出数据导入",
      archivePickFailed: "无法打开 Claude 导出文件选择器。",
      archiveResult:
        "已从 Claude 导出中导入 {{sessions}} 个对话和 {{messages}} 条消息",
      archiveScanFailed: "无法将这个 ZIP 读取为支持的 Claude 数据导出。",
      archiveScanning: "正在读取 Claude 导出对话...",
      archiveSearchPlaceholder: "搜索 Claude 对话",
      archiveSelectionReady:
        "Claude 导出扫描完成，有 {{count}} 个对话可供检查。",
      archiveSelectDescription: "搜索并勾选要导入的 Claude 对话",
      back: "返回",
      chooseArchive: "选择 ZIP",
      description: "导入本机 Codex、Claude Code 历史或 Claude 数据导出",
      done: "完成",
      empty: "未找到本机 Codex 或 Claude Code 的项目历史",
      errors: "跳过的项目",
      import: "导入",
      importFailed: "暂时无法导入外部 Agent 历史。",
      importing: "导入中...",
      chatOptionDescription: "最近 30 天 · {{messages}} 条消息",
      chatOptionTitle: "聊天会话（{{count}}）",
      optionDescription: "选择要从扫描结果中导入的内容",
      projectOptionDescription: "使用已有项目文件夹",
      projectOptionTitle: "项目（{{count}}）",
      providerDescription: "选择要扫描的本机应用",
      selectTitle: "选择要导入的对话",
      selectDescription: "搜索并勾选要导入的项目和对话",
      searchPlaceholder: "搜索项目和对话",
      selectAll: "全选",
      selectedCount: "已选 {{selected}} / {{total}}",
      noResults: "没有匹配的对话",
      registerProjects: "同时注册项目文件夹",
      sessionMessages: "{{count}} 条消息",
      rangeLabel: "时间范围",
      range7: "7 天",
      range30: "30 天",
      range90: "90 天",
      rangeAll: "全部",
      selectSession: "选择 {{title}}",
      selectProjectGroup: "选择「{{label}}」的全部对话",
      promptDescription: "Tutti 可以导入最近的 {{provider}} 项目会话",
      promptImport: "导入",
      promptLater: "稍后",
      promptTitle: "导入已有 AI 聊天",
      result:
        "已从 {{projects}} 个项目导入 {{sessions}} 个会话和 {{messages}} 条消息",
      resultSkipped: "已跳过 {{count}} 个空的或不支持的对话",
      scan: "扫描",
      scanFailed: "暂时无法扫描外部 Agent 历史。",
      scanning: "正在扫描本机 Agent 历史...",
      selectProvider: "选择 {{label}}",
      selectImportOption: "选择 {{label}}",
      settingsAction: "导入",
      settingsDescription:
        "将本机 Codex、Claude Code 历史或 Claude 导出对话导入 Tutti",
      settingsLabel: "导入会话历史",
      title: "从 AI 应用导入"
    },
    analyticsDebug: {
      clear: "清空",
      close: "关闭埋点事件",
      clientTimestamp: "client_ts：{{value}}",
      count: "{{count}} 条事件",
      empty: "暂无埋点事件",
      open: "打开埋点调试事件",
      title: "埋点事件"
    },
    appCenter: {
      backToApps: "返回应用",
      dockLabel: "应用",
      tabs: {
        close: "关闭应用标签页",
        label: "已打开的应用",
        new: "打开其他应用"
      }
    },
    info: {
      idDescription: "用于 preload 和 daemon 协调的稳定标识。",
      idLabel: "工作区 ID",
      lastOpenedDescription: "这个工作区上次被恢复或打开的时间。",
      lastOpenedLabel: "上次打开",
      rendererRoleDescription:
        "桌面 UI 保持为展示层，durable state 仍由 tuttid 持有。",
      rendererRoleLabel: "Renderer 角色",
      rendererRoleValue: "UI 外壳"
    },
    meta: {
      daemonLabel: "daemon",
      platformLabel: "平台"
    },
    ready: {
      description:
        "这个界面目前故意保持轻量。等 UI system 稳住后，我们就可以在这里叠加真正的工作区模块。",
      panelOne:
        "导航、富内容和工作区模块现在可以构建在 React、Tailwind 和共享 primitives 上，不需要继续扩张旧的全局样式表。",
      panelTwo:
        "preload bridge 和 daemon API 都保持不变，所以这次迁移只影响 renderer 的组合方式和视觉基础设施。",
      title: "工作区已准备就绪"
    },
    routeDescription:
      "窗口路由仍通过 query 参数解析，以便保持 Electron shell 简单清晰。",
    runtime: {
      connectedDescription: "{{service}} 已连接。",
      pendingDescription: "健康检查尚未完成。",
      statusDescription:
        "健康状态和 shell 元数据现在通过共享 tokens 和组件来渲染。",
      statusTitle: "运行时状态"
    },
    wallpaper: {
      options: {
        custom: "自定义",
        default: "默认",
        dunes: "星夜沙丘",
        ocean: "海面",
        orbit: "地球夜景",
        peaks: "雪峰夜空",
        sand: "流沙纹理",
        sky: "云层",
        tutti: "Tutti"
      }
    },
    settings: {
      close: "关闭设置",
      agent: {
        agents: {
          autoCheckUpdates: "自动检查更新",
          autoCheckUpdatesFailed: "无法保存自动检查更新设置",
          autoCheckUpdatesHint: "定期检查；只有点击更新后才会安装",
          checkUpdates: "检查更新",
          checkUpdatesFailed: "暂时无法检查 Agent CLI 更新",
          checkingUpdates: "正在检查更新…",
          currentVersionSummary: "{{current}}",
          disabled: "已停用",
          earlyAccessBadge: "抢先体验",
          earlyAccessDescription: "显示仍在 Tutti 中测试和验证的 Agent 集成",
          earlyAccessHiddenHint:
            "在实验室中开启抢先体验 Agent 集成即可管理 {{agent}}",
          earlyAccessLabel: "抢先体验 Agent 集成",
          empty: "暂无可显示的 Agent",
          enableAgent: "启用 {{agent}}",
          enableChangeFailed: "无法更改 {{agent}} 的启用状态",
          enabled: "已启用",
          enabledColumn: "启用状态",
          environmentColumn: "就绪状态",
          extensionCodeBuddy: "CodeBuddy Code",
          extensionEnableToSetUp: "启用后进行设置",
          extensionGemini: "Gemini CLI",
          extensionGrok: "Grok Build",
          extensionHermes: "Hermes Agent",
          extensionGitHubCopilot: "GitHub Copilot CLI",
          extensionKilo: "Kilo Code",
          extensionKimiCode: "Kimi Code",
          extensionPreparing: "正在准备集成…",
          extensionQwen: "Qwen Code",
          updateAvailableLatest: "有可用更新 · {{latest}}",
          updateAvailableSummary: "{{current}} → {{latest}}",
          updateCheckFailed: "暂时无法检查更新",
          updateCheckFailedSummary: "{{current}} · 暂时无法检查",
          updateUpToDateSummary: "{{current}} · 已是最新"
        },
        tabs: {
          agents: "Agent Runtime",
          automation: "自动化",
          customAgents: "自定义 Agent",
          general: "通用设置"
        }
      },
      appearance: {
        dockPlacementDescription: "控制工作区 dock 栏停靠的位置",
        dockPlacementLabel: "Dock 布局",
        dockPlacementOptions: {
          bottom: "底部",
          left: "左侧"
        },
        dockPlacementSaveFailed: "暂时无法更新 Dock 布局",
        dockIconStyleSaveFailed: "暂时无法更新 Dock 图标风格",
        minimizeAnimationDescription: "控制窗口最小化到 Dock 时使用的动画",
        minimizeAnimationLabel: "最小化动画",
        minimizeAnimationOptions: {
          genie: "Genie",
          off: "关闭",
          scale: "缩放"
        },
        minimizeAnimationSaveFailed: "暂时无法更新最小化动画",
        workbenchWindowSnappingDescription:
          "开启边缘、四角吸附以及键盘窗口整理",
        workbenchWindowSnappingLabel: "窗口吸附",
        workbenchWindowSnappingSaveFailed: "暂时无法更新窗口吸附设置",
        workbenchWindowSnappingShortcutLabel: "窗口吸附快捷键",
        workbenchWindowSnappingShortcutOptions: {
          off: "关闭",
          commandArrows: "Command + 方向键",
          commandShiftArrows: "Command + Shift + 方向键"
        },
        themeDescription: "控制窗口外观以及信息的颜色模式",
        themeLabel: "外观",
        themeOptions: {
          dark: "深色",
          light: "浅色",
          system: "跟随系统"
        },
        themeSaveFailed: "暂时无法切换应用外观",
        wallpaperDisplayModeLabel: "显示方式",
        wallpaperDisplayModeOptions: {
          center: "居中",
          fit: "适合于屏幕",
          original: "原图",
          stretch: "拉伸以充满屏幕"
        },
        wallpaperLabel: "壁纸",
        wallpaperRemove: "移除自定义壁纸",
        wallpaperRemoveFailed: "暂时无法移除自定义壁纸",
        wallpaperUpload: "上传壁纸",
        wallpaperUploadError: "无法将这张图片用作壁纸",
        wallpaperUploadErrorTooLarge: "图片太大了，请选择更小的文件",
        wallpaperUploadErrorType: "不支持的图片格式，请选择 PNG、JPG 或 WebP",
        wallpaperUploading: "上传中..."
      },
      general: {
        workspaceUiModeLabel: "窗口交互模式",
        workspaceUiModeOptions: {
          agentTitle: "独立 Agent 窗口模式",
          agentBadge: "Beta",
          agentDescription:
            "启动独立的 Agent 窗口，文件、工具等通过右侧面板打开",
          osTitle: "沉浸 OS 模式",
          osDescription: "保留沉浸式桌面体验，包括多窗口、Dock栏、启动台等"
        },
        workspaceUiModeSaveFailed: "暂时无法更新启动界面",
        defaultAgentProviderDescription:
          "当任务或工作区应用未指定 Provider 时，使用这里选择的 Provider",
        defaultAgentProviderLabel: "默认 Provider",
        defaultAgentProviderSaveFailed: "暂时无法更新默认 Provider",
        agentConversationDetailModeLabel: "工作模式",
        agentConversationDetailModeOptions: {
          codingTitle: "适用于编程",
          codingDescription: "更具技术性的回复和控制",
          generalTitle: "适用于日常工作",
          generalDescription: "同样强大，技术细节更少"
        },
        agentConversationDetailModeSaveFailed: "暂时无法更新工作模式",
        deletedConversationRetentionLabel: "已删除会话清理",
        deletedConversationRetentionDescription:
          "在所选期限后永久移除软删除的 Agent 会话，仅清理 Tutti 管理的数据",
        deletedConversationRetentionDays: "{{count}} 天",
        deletedConversationRetentionSaveFailed: "暂时无法更新清理期限",
        deletedConversationPurgeAction: "立即清理",
        deletedConversationPurging: "正在清理…",
        deletedConversationPurgeTitle: "永久清理已删除会话？",
        deletedConversationPurgeDescription:
          "这会移除本设备上全部软删除的 Agent 会话且无法撤销，请输入「{{phrase}}」继续",
        deletedConversationPurgeConfirmationPhrase: "永久清理",
        deletedConversationPurgeConfirmationLabel: "确认文字",
        deletedConversationPurgeConfirm: "永久清理",
        deletedConversationPurgeCompleted: "已清理 {{count}} 个已删除会话",
        deletedConversationPurgeFailed:
          "暂时无法清理，请先结束正在运行的 Agent 任务后重试",
        computerUseLabel: "电脑控制",
        computerUseDescription:
          "让 Agent 控制你的 Mac 桌面——截图、点击、键盘输入等",
        computerUseInstallButton: "安装",
        computerUseInstalling: "正在安装…",
        computerUseInstallSuccess: "cua-driver 安装成功",
        computerUseInstallFailed: "安装失败",
        computerUseUninstallButton: "移除",
        computerUseUninstalling: "正在移除…",
        computerUseUninstallSuccess: "cua-driver 已移除",
        computerUseUninstallFailed: "移除失败",
        computerUseProgressAria: "电脑控制设置进度",
        computerUseManageButton: "管理",
        computerUseGrantButton: "授权",
        computerUseGrantAccessibilityButton: "授权辅助使用",
        computerUseGrantScreenRecordingButton: "授权屏幕录制",
        computerUseAuthorizedButton: "已授权",
        computerUseGranting: "等待授权…",
        computerUseGrantingAccessibility: "等待辅助使用授权…",
        computerUseGrantingScreenRecording: "等待屏幕录制授权…",
        computerUseCheckingCaptureAvailability: "正在检查屏幕捕获状态…",
        computerUseStartAndCheckButton: "启动并检查",
        computerUseStartingCuaDriver: "正在启动并检查…",
        computerUseGrantSuccess: "已授权",
        computerUseGrantFailed: "授权失败",
        computerUseGrantAccessibilityInstruction:
          "下一步：授权辅助使用完成后继续授权屏幕录制",
        computerUseGrantScreenRecordingInstruction: "下一步：授权屏幕录制",
        computerUseScreenRecordingCaptureUnavailableInstruction:
          "屏幕录制已经授权，但需要重启 CuaDriver 才能生效点击「重启生效」即可自动完成",
        computerUseGrantUnknownInstruction:
          "无法确认授权状态点击后会由 CuaDriver 再次检查",
        computerUseDriverDaemonNotRunningInstruction:
          "CuaDriver 未在运行，暂时无法读取授权状态点击「启动」即可启动 CuaDriver 并自动检查",
        computerUseStartingCuaDriverInstruction:
          "正在启动 CuaDriver 并检查授权状态…",
        computerUseGrantTimedOutInstruction:
          "macOS 没有弹出授权确认请打开系统设置 > 隐私与安全性，为 CuaDriver 打开所需权限，然后回到 Tutti 重新检查",
        computerUseGrantAccessibilityTimedOutInstruction:
          "macOS 没有弹出辅助使用授权确认请打开系统设置 > 隐私与安全性 > 辅助使用，启用 CuaDriver，然后回到 Tutti 重新检查",
        computerUseGrantScreenRecordingTimedOutInstruction:
          "macOS 没有弹出屏幕录制授权确认请打开系统设置 > 隐私与安全性 > 屏幕与系统音频录制，启用 CuaDriver，然后回到 Tutti 重新检查",
        computerUseGrantManualFallbackInstruction:
          "如果 macOS 没有弹出授权确认，请打开{{settings}}并手动启用 CuaDriverTutti 会在后台继续检查",
        computerUseOpenAccessibilitySettingsButton: "打开辅助使用设置",
        computerUseOpenScreenRecordingSettingsButton: "打开屏幕录制设置",
        computerUseOpenPrivacySettingsButton: "打开隐私设置",
        computerUseOpeningSettings: "正在打开设置…",
        computerUseOpenSettingsTooltip:
          "打开对应的 macOS 隐私设置页面保持此面板打开时，Tutti 会自动检查授权状态",
        computerUseOpenSettingsFailed: "无法打开系统设置",
        computerUseAccessibilitySettingsOpenedInstruction:
          "辅助使用设置已打开请在那里启用 CuaDriver，Tutti 会自动检查",
        computerUseScreenRecordingSettingsOpenedInstruction:
          "屏幕录制设置已打开请在那里启用 CuaDriver，Tutti 会自动检查",
        computerUsePrivacySettingsOpenedInstruction:
          "隐私设置已打开请在那里启用 CuaDriver 所需权限，Tutti 会自动检查",
        computerUseAuthorizedTooltip: "CuaDriver 已具备屏幕录制与辅助使用权限",
        computerUsePermissionUnknownTooltip:
          "无法确认授权状态，点击后会由 CuaDriver 检查并引导授权",
        computerUsePermissionMissingTooltip: "需要授权：{{permissions}}",
        computerUsePermissionAccessibility: "辅助使用",
        computerUsePermissionScreenRecording: "屏幕录制",
        computerUsePermissionListSeparator: "、",
        computerUsePermissionDialogTitle: "设置电脑控制",
        computerUsePermissionDialogDescription:
          "Tutti 会引导授权流程，macOS 会把权限授予 CuaDriver",
        computerUsePermissionDialogRelationshipTitle:
          "为什么授权给 CuaDriver？",
        computerUsePermissionDialogRelationshipBody:
          "Tutti 通过 CuaDriver 来完成截图、点击和键盘输入接下来 macOS 可能会提示你授权 CuaDriver，这是正常的",
        computerUsePermissionDialogIconHint:
          "打开系统设置后，在权限列表里找到「CuaDriver」，并打开权限开关",
        computerUsePermissionDialogRequiredTitle: "需要的权限",
        computerUsePermissionDialogActionTitle: "当前操作",
        computerUsePermissionDialogActionReady:
          "CuaDriver 已具备 Tutti 进行电脑控制所需的权限",
        computerUsePermissionDialogAutoCheck:
          "保持此弹窗打开时，Tutti 会自动检查授权状态",
        computerUsePermissionStatusGranted: "已生效",
        computerUsePermissionStatusMissing: "需要授权",
        computerUsePermissionStatusUnknown: "未知",
        computerUsePermissionStatusCaptureUnavailable: "已授权，未生效",
        computerUseStatusInstalled: "已安装",
        computerUseStatusNotInstalled: "未安装",
        computerUseStatusCheckAgain: "重新检查",
        computerUseDriverRowLabel: "CuaDriver 运行状态",
        computerUseDriverStatusRunning: "运行中",
        computerUseDriverStatusNotRunning: "未运行",
        computerUseStartDriverButton: "启动",
        computerUseRestartDriverButton: "重启生效",
        computerUseRestartingDriver: "正在重启 CuaDriver…",
        computerUseRestartDriverFailed:
          "重启 CuaDriver 失败请重试，或手动打开 CuaDriver 应用后再重新检查",
        computerUseOpenPaneButton: "打开设置",
        computerUseStatusCheckFailed: "无法获取权限状态，请重试",
        computerUseStatusRetryButton: "重试",
        computerUseStatusUnchanged: "已重新检查，状态未变化",
        computerUseLastCheckedAt: "上次检查 {{time}}",
        computerUseDoneButton: "完成",
        computerUseWizardBack: "上一步",
        computerUseWizardNext: "下一步",
        computerUseWizardInstallBody:
          "安装 CuaDriver——负责执行截图、点击和键盘输入的本地驱动安装不会请求任何权限",
        computerUseWizardGrantInstruction:
          "打开系统设置后，在「{{permission}}」列表里找到「CuaDriver」，并打开权限开关完成后点「下一步」",
        computerUseWizardScreenRecordingKillNote:
          "打开开关时 macOS 可能提示重新打开 CuaDriver，可以忽略，下一步会自动处理",
        computerUseWizardVerifyBody:
          "完成前面两步授权后，点击「重新检查」确认一切就绪（约 2 秒）如果某项显示「需要授权」，点它旁边的「去授权」补上即可",
        computerUseWizardVerifyChecking: "正在重新检查…",
        computerUseWizardGrantStepReturn: "去授权",
        computerUseWizardDoneBody:
          "电脑控制已就绪，Agent 现在可以操作你的桌面了",
        browserUseConnectionModeDescription:
          "选择 Agent 执行网页任务时所控制的浏览器",
        browserUseConnectionModeLabel: "浏览器连接",
        browserUseConnectionModeOptions: {
          autoConnect: "复用我的 Chrome",
          isolated: "独立浏览器"
        },
        browserUseConnectionModeOptionHints: {
          autoConnect:
            "让 Agent 直接控制你电脑上正在使用的 Chrome需先在 Chrome 的 chrome://inspect/#remote-debugging 中开启远程调试更改会在下一次浏览器会话启动时生效",
          isolated:
            "由 Tutti 单独启动一个浏览器供 Agent 使用，不影响你日常使用的 Chrome更改会在下一次浏览器会话启动时生效"
        },
        browserUseConnectionModeSaveFailed: "暂时无法更新浏览器连接设置",
        agentDiagnosticsReportingLabel: "针对上报",
        agentDiagnosticsReportingDescription:
          "检测到环境异常时，上报更完整的诊断信息（CLI 路径、端点、代理地址、错误详情）以帮助排查账号邮箱不会上报",
        languageDescription: "会立刻应用到所有已打开窗口，并在重启后继续生效",
        languageLabel: "语言",
        languageOptions: {
          en: "English",
          zhCN: "简体中文"
        },
        localeSaveFailed: "暂时无法切换应用语言",
        preventSleepDescription: "可控制系统是否进入休眠",
        preventSleepLabel: "防止休眠",
        preventSleepOptions: {
          always: "始终防止休眠",
          never: "允许电脑休眠",
          whileAgentRunning: "仅 Agent 运行时防止休眠"
        },
        preventSleepSaveFailed: "暂时无法更新防止休眠设置",
        updateChannelSaveFailed: "暂时无法更新发布渠道",
        updatePolicySaveFailed: "暂时无法更新更新方式",
        versionLabel: "桌面版本"
      },
      nav: {
        about: "关于",
        account: "账号",
        apps: "应用",
        sectionsLabel: "设置分区",
        appearance: "外观",
        agent: "Agent",
        developer: "开发者",
        general: "通用",
        lab: "实验室",
        model: "模型"
      },
      about: {
        appName: "Tutti",
        developerModeEnabled: "开发者模式已打开",
        githubAction: "GitHub",
        versionLabel: "版本",
        websiteAction: "官方网站"
      },
      account: {
        description: "登录后可在此设备使用你的 Tutti 账号",
        login: "登录",
        logout: "退出登录",
        refresh: "刷新",
        reopenLogin: "重新打开登录页",
        signedOutTitle: "未登录",
        signingIn: "登录中...",
        signingOut: "退出中..."
      },
      apps: {
        appCatalogChannelDescription:
          "选择应用中心显示已正式发布的应用，还是用于试用的新版本",
        appCatalogChannelLabel: "应用来源",
        appCatalogChannelOptions: {
          production: "正式应用",
          staging: "测试应用"
        },
        appCatalogChannelSaveFailed: "暂时无法切换应用来源",
        agents: {
          addAgent: "添加 Agent",
          defaultModelLabel: "默认模型",
          delete: "删除",
          deleteConfirm: "删除这个 Agent？",
          deleteFailed: "Agent 删除失败，请重试",
          deleting: "删除中...",
          description:
            "将 Agent Runtime 与模型方案、指令组合成具名的 Agent 选项",
          disabled: "已停用",
          edit: "编辑",
          editTitle: "编辑 {{agent}}",
          editorDescription: "保存后，它会成为新会话中可选择的一个 Agent",
          emptyDescription:
            "添加 Agent，把 Agent Runtime 和模型方案映射成可复用的会话选项",
          emptyTitle: "还没有工作区 Agent",
          ready: "可用",
          harnessLabel: "Agent Runtime",
          harnessUnavailable: "Agent Runtime 不可用",
          behaviorDetailsTitle: "完整指令与调用条件",
          callConditionsLabel: "调用条件",
          callConditionsPlaceholder: "发布决策前调用\n架构风险较高时调用",
          instructionsLabel: "指令",
          instructionsPlaceholder: "描述这个 Agent 应该如何开展工作",
          loadFailed: "暂时无法加载工作区 Agent",
          migrated: "由旧版绑定迁移",
          modelPlanLabel: "模型方案",
          nameLabel: "名称",
          namePlaceholder: "前端审查 Agent",
          noHarnesses: "暂无可用的 Agent Runtime",
          noModelPlan: "使用 Agent Runtime 默认模型",
          onePerLine: "每行填写一项",
          planDefaultModel: "使用方案默认模型",
          descriptionLabel: "描述",
          descriptionPlaceholder: "描述这个 Agent 的职责与适用场景",
          requiredFields: "请填写名称并选择 Agent Runtime",
          retry: "重试",
          save: "保存 Agent",
          saveFailed: "Agent 保存失败，请检查配置后重试",
          saving: "保存中...",
          title: "自定义 Agent"
        },
        automationRules: {
          addRule: "添加自动化",
          allAgents: "全部 Agent",
          allowedToolsHint: "不选择时跟随目标 Agent 的工具配置",
          allowedToolsLabel: "允许的工具",
          budgetDescription:
            "限制会对每个来源会话独立计算。填写 0 会使用 daemon 的安全默认值，不代表无限制",
          budgetLabel: "预算",
          budgetSummary: "{{runs}} 次 · {{tokens}} tokens",
          chooseTargetAgent: "选择目标 Agent",
          delete: "删除",
          deleteConfirm: "删除这条自动化？",
          deleteFailed: "自动化删除失败，请重试",
          deleting: "删除中...",
          description:
            "当 Agent 完成或失败任务后，自动新建一个目标 Agent 会话，并在首条消息中 @ 事件来源会话",
          disabled: "已停用",
          edit: "编辑",
          editTitle: "编辑 {{rule}}",
          editorDescription:
            "触发后会为目标 Agent 新建会话，首条消息包含你的提示词并 @ 事件来源会话。新自动化默认停用并使用保守限制",
          emptyDescription:
            "当 Agent 完成或失败工作后需要自动发起后续会话时，可添加一条规则",
          emptyTitle: "还没有自动化规则",
          enabled: "已启用",
          enabledLabel: "匹配的任务结束后自动运行",
          invalidBudget: "两个预算限制都必须填写非负整数",
          loadFailed: "暂时无法加载自动化规则",
          maxRunsLabel: "每个来源会话最多运行次数",
          maxTokensLabel: "每个来源会话最多使用 Token 数",
          nameLabel: "名称",
          namePlaceholder: "完成后续跟进",
          permissionModeDefault: "使用目标 Agent 的默认值",
          permissionModeLabel: "权限模式",
          promptLabel: "提示词",
          promptPlaceholder: "描述新会话应该执行的后续任务",
          requiredFields: "请填写名称并选择目标 Agent",
          retry: "重试",
          save: "保存自动化",
          saveFailed: "自动化保存失败，请检查目标、权限和预算",
          saving: "保存中...",
          sourceAgentLabel: "来源 Agent",
          targetAgentLabel: "目标 Agent",
          targetLabel: "目标",
          targetOptionsLoadFailed: "无法加载目标 Agent 的能力目录",
          targetOptionsLoading: "正在加载目标能力目录...",
          title: "自动化规则",
          toolsEmpty: "该目标没有可选工具，新会话将沿用目标 Agent 的工具配置",
          triggerLabel: "触发条件",
          triggers: {
            onTaskComplete: "任务完成时",
            onTaskFailed: "任务失败或中断时"
          }
        },
        modelPlans: {
          addModel: "添加模型",
          addPlan: "添加方案",
          agentRuntimePendingHint:
            "保存方案后，在下方选择兼容的 Agent 完成第一次真实调用，即可完成验证",
          apiKey: "API 密钥",
          baseUrl: "Base URL",
          defaultMarker: "默认",
          delete: "删除",
          deleteBlockedDescription: "改绑或停用以下引用后才能删除",
          deleteBlockedTitle: "该方案仍被引用，无法删除",
          deleteConfirm: "删除此方案？",
          deleteFailed: "删除失败，请重试",
          deleting: "删除中...",
          description:
            "配置具名的模型接入方案——官方订阅、Coding Plan、国内模型、中转服务或自定义接口，供工作区的 Agent 和应用使用",
          confirmModelRangeImpact: "确认影响并保存",
          detect: "检测连接",
          detectFailed: "连接检测失败，请重试",
          detecting: "检测中...",
          detectionRequired: "保存方案前，请先完成并通过连接检测",
          detectionTitle: "连接检测",
          duplicate: "复制",
          duplicateFailed: "复制失败，请重试",
          edit: "编辑",
          editTitle: "编辑 {{plan}}",
          emptyDescription:
            "点「添加方案」用你的 API 密钥接入订阅、中转或自定义接口",
          emptyTitle: "还没有模型方案",
          enabled: "启用 {{plan}}",
          failureReasons: {
            connectionFailed: "无法连接到接入点",
            inferenceFailed: "测试调用失败",
            modelCatalogDecodeFailed: "模型列表响应无法解析",
            modelCatalogUnavailable: "模型列表不可用",
            modelRejected: "接入点拒绝了该模型",
            noModelSelected: "没有可用于测试调用的模型",
            providerAuthRequired: "需要先登录模型提供商",
            providerRuntimeUnavailable: "对应的 Agent Runtime 当前不可用",
            unauthorized: "接入点拒绝了凭证",
            unknown: "检测失败"
          },
          fetchModels: "拉取模型",
          fetchModelsEmpty: "接口未返回可选模型，你仍可手动输入模型 ID",
          fetchModelsFailed: "拉取模型失败，请检查凭证与 Base URL 后重试",
          fetchModelsResult: "已拉取 {{count}} 个可选模型",
          fetchingModels: "拉取中...",
          getApiKey: "获取 {{provider}} API 密钥",
          hideApiKey: "隐藏密钥",
          keepExistingKey: "留空则继续使用已保存的密钥",
          lastDetectedAt: "上次检测 {{time}}",
          loadFailed: "暂时无法加载模型方案",
          modelCount: "{{count}} 个模型",
          modelId: "模型 ID",
          modelPickerEmpty: "没有匹配的模型",
          modelPickerPlaceholder: "选择或输入模型 ID",
          modelPickerSearchPlaceholder: "搜索模型 ID 或名称",
          modelPickerUseCustom: "使用自定义 ID“{{model}}”",
          nativeLoginHint:
            "此方案使用本机 Codex 或 Claude Code 已有的登录状态。如尚未登录，请先前往 Agent 设置完成登录，再运行连接检测；方案不会保存 API 密钥或 Base URL",
          modelRangeImpactDescription:
            "以下引用会在下一次调用时使用变更后的模型范围。请确认影响后再次保存；运行中的调用不会改变",
          modelRangeImpactTitle: "确认受影响的引用",
          models: "模型",
          nameLabel: "名称",
          namePlaceholder: "我的模型方案",
          neverDetected: "尚未检测",
          pendingFirstUseGuide:
            "选择兼容的 Agent 并完成一次真实调用后，方案才算可用",
          firstUseAction: "用此 Agent 试用",
          firstUseAgentLabel: "兼容 Agent",
          firstUseLaunchFailed: "无法打开首次使用会话",
          firstUseLaunching: "正在打开...",
          firstUsePrompt:
            "请使用 {{plan}} 模型方案完成这次真实首次调用，简要介绍所选模型并确认它能在当前工作区正常响应",
          noCompatibleFirstUseAgent: "当前没有启用与此方案协议兼容的 Agent",
          presetLabel: "服务商预设",
          presets: {
            agnes: "Agnes",
            anthropicOfficial: "Anthropic (Claude)",
            codingPlanAnthropic: "Claude Coding Plan",
            codingPlanCustom: "其他 Coding Plan",
            customAnthropic: "自定义 Anthropic 兼容接口",
            customOpenai: "自定义 OpenAI 兼容接口",
            deepseekAnthropic: "DeepSeek - Anthropic",
            deepseekOpenai: "DeepSeek - OpenAI",
            mimoAnthropic: "MiMo (Xiaomi) - Anthropic",
            mimoOpenai: "MiMo (Xiaomi) - OpenAI",
            minimaxAnthropic: "MiniMax - Anthropic",
            minimaxOpenai: "MiniMax - OpenAI",
            openaiOfficial: "OpenAI 官方",
            relayCustom: "中转接入点"
          },
          protocolLabel: "接口协议",
          protocols: {
            anthropic: "Anthropic 兼容",
            openai: "OpenAI 兼容"
          },
          referenceKinds: {
            agentTarget: "Agent",
            modelPolicy: "模型策略",
            workspaceAgent: "工作区 Agent",
            workspaceApp: "应用"
          },
          remedies: {
            addModelsManually: "请手动添加模型",
            checkApiKey: "请检查 API 密钥",
            checkModelId: "请检查模型 ID",
            checkNetworkOrBaseUrl: "请检查网络或 Base URL",
            enableProvider: "请安装或启用对应的 Agent Runtime",
            loginProvider: "请前往 Agent Runtime 设置完成登录",
            retryCompatibleAgent: "请使用提供商对应的 Agent Runtime 重试",
            selectModel: "请先选择模型"
          },
          removeModel: "移除模型",
          setDefaultModel: "将 {{model}} 设为默认模型",
          requiredFieldsMissing:
            "请填写名称和模型列表；接口方案还需要 API 密钥与 Base URL",
          save: "保存",
          saveFailed: "保存失败，请重试",
          saving: "保存中...",
          showApiKey: "显示密钥",
          stageLatency: "{{ms}} ms",
          stageStatus: {
            failed: "失败",
            passed: "通过",
            pending: "待检测",
            skipped: "已跳过"
          },
          stages: {
            agentRuntime: "Agent 首次调用",
            auth: "认证",
            inference: "真实调用",
            modelDiscovery: "模型列表",
            network: "网络"
          },
          statusLabels: {
            detectionFailed: "检测失败",
            disabled: "已停用",
            pendingFirstUse: "待首次使用",
            ready: "可用",
            undetected: "待检测"
          },
          templateGroups: {
            codingPlan: {
              guidance:
                "使用编程套餐（如 Claude Coding Plan）提供的接入点和密钥",
              label: "Coding Plan"
            },
            custom: {
              guidance: "使用你自己的密钥接入任意 OpenAI 或 Anthropic 兼容接口",
              label: "自定义兼容接口"
            },
            domestic: {
              guidance: "接入 DeepSeek、MiniMax、MiMo 等国内模型服务",
              label: "国内模型"
            },
            officialSubscription: {
              guidance: "使用服务商官方 API 密钥直连官方订阅",
              label: "官方订阅"
            },
            relay: {
              guidance: "使用聚合一个或多个服务商的中转/代理服务接入点",
              label: "中转服务"
            }
          },
          templatePickerTitle: "选择接入方式",
          title: "模型方案",
          toggleFailed: "状态更新失败，请重试"
        }
      },
      developer: {
        actionsLabel: "操作",
        analyticsDebugDescription: "显示本地埋点事件悬浮面板",
        analyticsDebugLabel: "埋点事件面板",
        clearConversationHistory: "清除全部对话历史",
        clearConversationHistoryConfirm:
          "删除当前工作区的全部 Agent 对话历史？此操作无法撤销",
        clearLogs: "清理日志",
        clearingConversationHistory: "清除中...",
        clearingLogs: "清理中...",
        conversationHistoryCleared: "已清除 {{count}} 个对话",
        conversationHistoryClearFailed: "暂时无法清除对话历史",
        daemonLogLabel: "Daemon 日志",
        desktopLogLabel: "Desktop 日志",
        exportLogs: "导出日志",
        exportRecentTenMinutesLogsOnly: "最近 10 分钟 · 仅日志",
        exportRecentTenMinutesLogsWithSessions:
          "最近 10 分钟 · 日志 + Session 记录",
        exportRecentThreeDaysLogsOnly: "最近 3 天 · 仅日志",
        exportRecentThreeDaysLogsWithSessions:
          "最近 3 天 · 日志 + Session 记录",
        exportLogsDialogTitle: "导出日志",
        exportLogsFileType: "Zip 压缩包",
        exportingLogs: "导出中...",
        fileDefaultOpenerActionLabel: ".{{extension}} 的默认打开方式",
        fileDefaultOpenerExtensionLabel: "文件后缀",
        fileDefaultOpenerExtensionPlaceholder: "html",
        fileDefaultOpenerNewActionLabel: "新的默认打开方式",
        fileDefaultOpenerOptions: {
          appBrowser: "内置浏览器",
          defaultBrowser: "默认浏览器",
          fileViewer: "文件查看器",
          system: "系统默认"
        },
        fileDefaultOpenersDescription:
          "按文件后缀选择工作区文件激活时优先使用的打开方式",
        fileDefaultOpenersLabel: "默认文件打开方式",
        labVisibilityDescription: "在独立设置页中显示实验性控制项",
        labVisibilityLabel: "显示实验室页",
        logMissing: "暂无文件",
        logOpenFailed: "暂时无法打开这个日志路径",
        logsCleared: "已清理 {{count}} 个日志文件（{{size}}）",
        logsClearFailed: "暂时无法清理本地日志",
        logsDirectoryLabel: "日志目录",
        logsExported: "已导出 {{count}} 个日志文件到 {{path}}",
        logsExportFailed: "暂时无法导出本地日志",
        logsLoadFailed: "暂时无法加载本地日志信息",
        qwenAgentDescription:
          "在 Tutti 中显示 Qwen Code，Agent Extension 预览期间默认关闭",
        qwenAgentLabel: "启用 Qwen Code Agent",
        grokAgentDescription:
          "加载已签名的 Grok Build Agent Extension，并在 AgentGUI 中显示",
        grokAgentLabel: "启用 Grok Build Agent",
        logsSizeLabel: "日志大小",
        logsSummary: "{{count}} 个文件，共 {{size}}",
        logsTitle: "日志",
        openDaemonLog: "打开 daemon 日志",
        openDesktopLog: "打开 desktop 日志",
        openLogsDirectory: "打开日志目录",
        addFileDefaultOpener: "添加",
        removeFileDefaultOpener: "移除 .{{extension}}",
        releaseChannelDescription: "选择稳定版更新；需要提前验收时可切到预览版",
        releaseChannelLabel: "发布渠道",
        referenceProvenanceFilterDescription:
          "在 Agent 对话的引用选择器中启用智能体来源筛选",
        referenceProvenanceFilterLabel: "智能体来源筛选",
        quickPromptLibraryDescription:
          "在 Agent 输入框中显示个人快捷提示词库入口",
        quickPromptLibraryLabel: "快捷提示词库",
        quickPromptLibrarySaveFailed: "暂时无法更新快捷提示词库可用状态",
        releaseChannelOptions: {
          rc: "预览版",
          stable: "稳定版"
        },
        showAppDeveloperSourcesDescription:
          "在应用中心卡片中展示应用作者和 GitHub 来源",
        showAppDeveloperSourcesLabel: "展示应用作者与来源",
        showAppDeveloperSourcesSaveFailed: "暂时无法更新应用中心来源展示设置",
        tuttiAgentSwitchDescription: "显示账号与 Agent 开发控制项",
        tuttiAgentSwitchLabel: "Tutti Agent Switch",
        tuttiAgentSwitchSaveFailed: "暂时无法更新 Tutti Agent 可用状态",
        visibilityDescription:
          "在设置中隐藏此面板在「关于」里连续点击版本号七次即可重新显示",
        visibilityLabel: "显示开发者面板"
      },
      lab: {
        backLabel: "返回",
        automationRulesDescription: "显示自动化规则配置与会话覆盖选项",
        automationRulesLabel: "自动化规则",
        clearShortcutLabel: "清除 {{label}}",
        modelPlansDescription: "显示用于配置模型方案的模型设置",
        modelPlansLabel: "模型方案",
        newAgentConversationShortcutLabel: "新建 Agent 对话",
        newSameTypeWindowShortcutLabel: "新建同类型窗口",
        preferencesSaveFailed: "暂时无法更新实验室设置",
        previewAgentsDescription: "显示仍在 Tutti 中测试和验证的 Agent 集成",
        previewAgentsLabel: "抢先体验 Agent 集成",
        shortcutUnbound: "未绑定",
        tuttiModeDescription: "启用 Agent 对话中的 Tutti 模式规划与编排控制",
        tuttiModeLabel: "Tutti 模式",
        workbenchShortcutsDescription: "启用可配置的工作台快捷键操作",
        workbenchShortcutsLabel: "工作台快捷键",
        workbenchShortcutsManageLabel: "配置键盘快捷键",
        workspaceAgentsDescription: "显示自定义 Agent 的创建与配置",
        workspaceAgentsLabel: "自定义 Agent"
      },
      title: "设置",
      trigger: "设置"
    },
    workbenchDesktop: {
      closeGuard: {
        cancel: "取消",
        confirm: "终止终端",
        description: "这个终端仍有任务在运行。终止会停止当前终端会话。",
        title: "要终止这个终端吗？"
      },
      windowCloseGuard: {
        cancel: "保留窗口",
        confirm: "关闭窗口",
        description:
          "这个窗口里仍有任务在运行。关闭后会退出当前房间，但后台任务可能继续运行。",
        title: "要关闭这个窗口吗？"
      },
      windowControls: {
        close: "关闭",
        maximize: "最大化",
        minimize: "最小化",
        restore: "还原"
      },
      nodes: {
        agent: "Agent",
        appCenter: "应用",
        appWebview: "工作区应用",
        browser: "浏览器",
        files: "文件",
        imageFile: "图片文件",
        issues: "事项",
        textFile: "文本文件",
        terminal: "终端"
      },
      filePreview: {
        loading: "加载中...",
        revert: "还原",
        save: "保存",
        saved: "已保存",
        saveFailed: "保存失败",
        saving: "保存中...",
        unsaved: "有未保存更改",
        unsupportedFallback: "暂时不支持预览，使用本地软件打开。"
      },
      filesLaunch: {
        openFailedDescription: "无法在对应地址找到该文件或文件夹",
        openFailedTitle: "文件或文件夹已不存在"
      },
      agentProviders: {
        checking: "正在检测本地 CLI 状态...",
        comingSoon: "敬请期待",
        install: "连接",
        installFailed: "连接失败",
        installFailedDescription: "暂时无法连接本地 Agent，请稍后重试",
        installFailedMissingRuntime:
          "找不到本地 Agent 可执行文件，请检查是否已正确安装",
        installFailedOutdatedLocalAgent: "检测到旧版本本地 Agent，自动升级失败",
        installFailedTimedOut: "连接超时，请稍后重试",
        installUnavailableInRegion: "该地区不支持 Claude 服务。",
        installRequired: "需要先连接本地 Agent 才能继续",
        installing: "连接中",
        login: "登录",
        loginFailed: "登录失败",
        loginRequired: "需要先登录本地 CLI 才能使用这个 Agent",
        updateFailed: "更新失败",
        updateFailedDescription: "暂时无法更新本地 Agent，请稍后重试",
        updateFailedTimedOut: "更新超时，请稍后重试",
        manageActionConnect: "连接",
        manageActionLogin: "登录",
        manageActionOpeningLogin: "打开中...",
        manageActionUnavailableTooltip: "当前没有可用的智能体配置操作。",
        manageColumnAction: "操作",
        manageColumnAgent: "智能体",
        manageColumnConfig: "配置",
        manageColumnConnection: "连接状态",
        manageConfigDetected: "检测到本机配置",
        manageConfigMissing: "未检测到本机配置",
        manageProviderClaudeCode: "Claude Code",
        manageProviderCodex: "Codex",
        manageProviderCursor: "Cursor",
        manageProviderNexight: "Tutti Agent",
        manageProviderOpenClaw: "OpenClaw",
        manageProviderOpenCode: "Open Code",
        manageProviderTutti: "Tutti",
        manageProviderTuttiAgent: "Tutti Agent",
        manageStatusAuthRequired: "需要登录",
        manageStatusAvailable: "可连接",
        manageStatusChecking: "检测中",
        manageStatusConnected: "已连接",
        manageStatusUnknown: "状态不可用",
        manageStatusUnsupported: "后台更新中",
        manageTitle: "管理智能体",
        manageUnsupportedTooltip: "本地支持正在更新中，这个智能体暂时不可用。",
        refresh: "重新检测",
        unknown: "暂时无法确认本地 CLI 状态，请刷新重新检测"
      },
      launchpad: {
        agentUnavailable: "不可启动",
        appUnavailable: "不可启动",
        clearSearch: "清空搜索",
        close: "关闭启动台",
        dockLabel: "启动台",
        empty: "没有匹配的应用或 Agent",
        pageDot: "第 {{page}} 页，共 {{pageCount}} 页",
        pages: "启动台分页",
        searchPlaceholder: "搜索",
        unavailableItem: "{{title}}，{{reason}}"
      },
      missionControl: {
        activateShortcutDefault: "Ctrl + 1",
        activateShortcutMac: "Cmd + 1",
        activateTrigger: "快速激活节点",
        layoutShortcutDefault: "Ctrl + 2",
        layoutShortcutMac: "Cmd + 2",
        layoutTrigger: "快速布局",
        unavailableTrigger: "仅存在多个窗口时可使用",
        unlockLayoutTrigger: "解除固定布局"
      }
    }
  },
  errors: {
    daemon_unavailable: "本地运行时当前不可用。",
    electron_debug_required:
      "这个操作只在 Electron 里可用。请切回桌面端调试它。",
    invalid_request: {
      default: "这个请求暂时无法完成。",
      empty_body: "请求体为空。",
      entry_already_exists: "这个路径上已经存在同名文件或文件夹。",
      invalid_entry_kind: "这个文件操作使用了不支持的条目类型。",
      invalid_path: "这个路径无效。",
      invalid_upload_source: "一个或多个上传来源无效或暂时不可用。",
      invalid_workbench_snapshot: "工作台状态无效，暂时无法保存。",
      agent: {
        prompt_image_unsupported: "这个 Agent 暂时不支持图片输入。"
      },
      malformed_request: "这个请求暂时无法识别。",
      missing_workspace_id: "请先选择一个工作区再重试。",
      missing_workspace_name: "请输入工作区名称后再继续。",
      path_escapes_root: "这个路径超出了工作区根目录范围。",
      root_delete_forbidden: "不能删除工作区根目录。",
      workspace_app_icon_invalid: "请选择 5 MB 以内的 PNG、JPG 或 WebP 图片。",
      workspace_app_icon_replace_forbidden: "只有生成的应用可以替换图标。",
      workspace_app_package_exists: "这个应用版本已经存在。"
    },
    method_not_allowed: "这个请求当前不支持该操作。",
    logger_file_unavailable: "本地日志服务暂时不可用。",
    managed_process_exited: "本地运行时意外退出了。",
    managed_process_stderr: "本地运行时报告了内部错误。",
    node_runtime_broken:
      "npm 使用的 Node.js 运行时已损坏。请检查终端中的 Node/npm 配置后重试。",
    workspace_app_launch_requires_retry: "这个应用启动失败了，请先点击重试。",
    preview_file_too_large: "这个文件太大，暂时无法在这里预览。",
    service_unavailable: {
      default: "对应服务暂时不可用。",
      workspace_file_service_unavailable: "工作区文件服务暂时不可用。",
      workspace_service_unavailable: "工作区服务暂时不可用。",
      workspace_workbench_service_unavailable: "工作区工作台暂时不可用。"
    },
    transport_connect_failed: "暂时无法连接到本地运行时。",
    transport_request_failed: "非预期内服务报错，请重试",
    transport_timeout: "这个桌面请求已超时。",
    workspace_app_factory_publish_failed:
      "发布应用前检查失败，请先修复 App Center 里的生成草稿。",
    workspace_file_not_found: "找不到这个工作区里的文件或文件夹。",
    workspace_not_found: "找不到这个工作区。",
    workspace_operation_failed: {
      default: "暂时无法完成这个工作区操作。",
      acp_adapter_version_mismatch:
        "本地 Agent 适配器不可用或版本不匹配。请先在 Dock 中重新连接 Agent，然后重试。"
    }
  }
} as const satisfies TranslationDictionary;
