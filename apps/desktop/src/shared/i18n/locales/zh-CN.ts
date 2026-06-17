import type { TranslationDictionary } from "../core/resources.ts";

export const zhCN = {
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
    workspace: "工作区"
  },
  workspaceApp: {
    managedCredentials: {
      allow: "允许",
      authorizationDetail:
        "应用会通过 Tutti 获取短期凭证，真实 provider key 仍保存在 Tutti。",
      authorizationMessage: "允许这个应用使用 {{providers}} 吗？",
      authorizationTitle: "授权托管模型",
      configuredProviders: "已配置的 provider"
    }
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
    downloadAction: "更新",
    downloadedTitle: "更新完成，立即安装",
    downloadingTitle: "正在下载 {{percent}}",
    errorTitle: "无法检查更新",
    restartAction: "安装",
    retryAction: "重试"
  },
  desktop: {
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
      edit: "编辑",
      exportLogsFailed: "无法导出日志",
      exportLogsTitle: "导出日志",
      exportServiceLogs: "导出服务日志...",
      file: "文件",
      help: "帮助",
      upToDateDetail: "Tutti {{version}} 是当前的最新版本。",
      upToDateMessage: "您使用的就是最新版本！",
      view: "显示",
      window: "窗口"
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
      collapseConversationRail: "收起会话列表",
      expandConversationRail: "展开会话列表",
      fallbackAgentLabel: "Agent",
      openSessionUnavailableDescription: "这个 Agent 会话已不存在或无法打开。",
      openSessionUnavailableTitle: "会话不可用"
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
      outcomeNotificationCompletedTitle: "{{title}} 已完成",
      outcomeNotificationFailedBody: "Agent 本次运行失败，点击查看会话。",
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
      dockLabel: "应用中心"
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
      appearance: {
        dockPlacementDescription: "控制工作区 dock 栏停靠的位置",
        dockPlacementLabel: "Dock 布局",
        dockPlacementOptions: {
          bottom: "底部",
          left: "左侧"
        },
        dockPlacementSaveFailed: "暂时无法更新 Dock 布局。",
        dockIconStyleSaveFailed: "暂时无法更新 Dock 图标风格。",
        themeDescription: "控制窗口外观以及信息的颜色模式",
        themeLabel: "外观",
        themeOptions: {
          dark: "深色",
          light: "浅色",
          system: "跟随系统"
        },
        themeSaveFailed: "暂时无法切换应用外观。",
        wallpaperDisplayModeLabel: "显示方式",
        wallpaperDisplayModeOptions: {
          center: "居中",
          fit: "适合于屏幕",
          original: "原图",
          stretch: "拉伸以充满屏幕"
        },
        wallpaperLabel: "壁纸",
        wallpaperRemove: "移除自定义壁纸",
        wallpaperRemoveFailed: "暂时无法移除自定义壁纸。",
        wallpaperUpload: "上传壁纸",
        wallpaperUploadError: "无法将这张图片用作壁纸。",
        wallpaperUploadErrorTooLarge: "图片太大了，请选择更小的文件。",
        wallpaperUploadErrorType: "不支持的图片格式，请选择 PNG、JPG 或 WebP。",
        wallpaperUploading: "上传中..."
      },
      general: {
        defaultAgentProviderDescription:
          "用于新的 App Factory 任务、Issue 任务，以及读取宿主默认值的工作区应用",
        defaultAgentProviderLabel: "默认 Provider",
        defaultAgentProviderSaveFailed: "暂时无法更新默认 Provider。",
        browserUseConnectionModeDescription:
          "选择 Agent 执行网页任务时控制哪个浏览器：你电脑上的 Chrome，或由 Tutti 单独启动的浏览器。",
        browserUseConnectionModeLabel: "浏览器连接",
        browserUseConnectionModeOptions: {
          autoConnect: "复用我的 Chrome",
          isolated: "独立浏览器"
        },
        browserUseConnectionModeOptionHints: {
          autoConnect:
            "让 Agent 直接控制你电脑上正在使用的 Chrome。需先在 Chrome 的 chrome://inspect/#remote-debugging 中开启远程调试。更改会在下一次浏览器会话启动时生效。",
          isolated:
            "由 Tutti 单独启动一个浏览器供 Agent 使用，不影响你日常使用的 Chrome。更改会在下一次浏览器会话启动时生效。"
        },
        browserUseConnectionModeSaveFailed: "暂时无法更新浏览器连接设置。",
        languageDescription: "会立刻应用到所有已打开窗口，并在重启后继续生效",
        languageLabel: "语言",
        languageOptions: {
          en: "English",
          zhCN: "简体中文"
        },
        localeSaveFailed: "暂时无法切换应用语言。",
        preventSleepDescription: "可控制系统是否进入休眠",
        preventSleepLabel: "防止休眠",
        preventSleepOptions: {
          always: "始终防止休眠",
          never: "允许电脑休眠",
          whileAgentRunning: "仅 Agent 运行时防止休眠"
        },
        preventSleepSaveFailed: "暂时无法更新防止休眠设置。",
        updateChannelSaveFailed: "暂时无法更新发布渠道。",
        updatePolicySaveFailed: "暂时无法更新更新方式。",
        versionLabel: "桌面版本"
      },
      nav: {
        apps: "应用",
        sectionsLabel: "设置分区",
        appearance: "外观",
        developer: "开发者",
        general: "通用"
      },
      apps: {
        managedModels: {
          apiKey: "API 密钥",
          addModel: "添加",
          addProvider: "添加",
          baseUrl: "Base URL",
          collapse: "收起",
          customProvider: "自定义",
          delete: "删除",
          deleteConfirm: "删除此配置？",
          deleteFailed: "删除失败，请重试。",
          deleting: "删除中...",
          description:
            "用你自己的 API 密钥接入模型，供工作区的应用和 Agent 使用",
          detectModels: "获取可用模型",
          detectingModels: "获取中...",
          detectModelsEmpty: "没有找到可用模型。",
          detectModelsFailed: "获取模型失败，请重试。",
          emptyDescription:
            "点「添加」用你的 API 密钥接入 Agnes、OpenAI 或 Anthropic",
          emptyTitle: "还没有接入模型供应商",
          enabled: "启用 {{provider}}",
          expand: "展开",
          getApiKey: "获取 {{provider}} API 密钥",
          hideApiKey: "隐藏密钥",
          keyConfigured: "密钥已保存",
          keyMissing: "还没填密钥",
          keepExistingKey: "留空则继续使用已保存的密钥",
          loadFailed: "暂时无法加载模型供应商。",
          modelId: "模型 ID",
          modelIdPlaceholder: "model-id",
          models: "模型",
          presetLabels: {
            agnes: "Agnes",
            anthropicClaude: "Anthropic (Claude)",
            deepseekAnthropic: "DeepSeek - Anthropic",
            deepseekOpenai: "DeepSeek - OpenAI",
            mimoAnthropic: "MiMo (Xiaomi) - Anthropic",
            mimoOpenai: "MiMo (Xiaomi) - OpenAI",
            minimaxAnthropic: "MiniMax - Anthropic",
            minimaxOpenai: "MiniMax - OpenAI",
            openaiOfficial: "OpenAI official"
          },
          removeModel: "移除模型",
          requiredFieldsMissing: "请先填写 API 密钥和 Base URL。",
          quickFillProvider: "选择服务商预设",
          save: "保存",
          saveFailed: "保存失败，请重试。",
          saving: "保存中...",
          showApiKey: "显示密钥",
          test: "测试连接",
          testFailed: "连接失败，请检查密钥或地址。",
          testSucceeded: "连接正常。",
          testing: "测试中...",
          modelCount: "{{count}} 个模型",
          title: "模型供应商"
        }
      },
      developer: {
        actionsLabel: "操作",
        analyticsDebugDescription: "在开发版本中显示本地埋点事件悬浮面板",
        analyticsDebugLabel: "埋点事件面板",
        clearLogs: "清理日志",
        clearingLogs: "清理中...",
        daemonLogLabel: "Daemon 日志",
        desktopLogLabel: "Desktop 日志",
        exportLogs: "导出日志",
        exportLogsDialogTitle: "导出日志",
        exportLogsFileType: "Zip 压缩包",
        exportingLogs: "导出中...",
        logMissing: "暂无文件",
        logOpenFailed: "暂时无法打开这个日志路径。",
        logsCleared: "已清理 {{count}} 个日志文件（{{size}}）。",
        logsClearFailed: "暂时无法清理本地日志。",
        logsDirectoryLabel: "日志目录",
        logsExported: "已导出 {{count}} 个日志文件到 {{path}}。",
        logsExportFailed: "暂时无法导出本地日志。",
        logsLoadFailed: "暂时无法加载本地日志信息。",
        logsSizeLabel: "日志大小",
        logsSummary: "{{count}} 个文件，共 {{size}}",
        logsTitle: "日志",
        openDaemonLog: "打开 daemon 日志",
        openDesktopLog: "打开 desktop 日志",
        openLogsDirectory: "打开日志目录",
        visibilityDescription:
          "在设置中隐藏此面板。在「通用」里连续点击版本号七次即可重新显示",
        visibilityLabel: "显示开发者面板"
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
      nodes: {
        agent: "Agent",
        appCenter: "应用中心",
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
      agentProviders: {
        checking: "正在检测本地 CLI 状态...",
        comingSoon: "敬请期待",
        install: "安装",
        installFailed: "安装失败",
        installRequired: "需要先安装本地组件才能使用这个 Agent",
        installing: "安装中...",
        login: "登录",
        loginFailed: "登录失败",
        loginRequired: "需要先登录本地 CLI 才能使用这个 Agent",
        refresh: "刷新",
        unknown: "暂时无法确认本地 CLI 状态"
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
        unavailableTrigger: "仅存在多个窗口时可使用"
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
    workspace_operation_failed: "暂时无法完成这个工作区操作。"
  }
} as const satisfies TranslationDictionary;
