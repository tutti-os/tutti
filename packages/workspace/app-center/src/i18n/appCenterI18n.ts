import {
  createI18nRuntime,
  createScopedI18nRuntime,
  createScopedLocaleObjectsI18nModuleManifest,
  type I18nDictionary,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";

type AppCenterI18nLocale = "en" | "zh-CN";

export const appCenterI18nNamespace = "appCenter";
export const nextopI18nModule = createScopedLocaleObjectsI18nModuleManifest({
  localeObjectByLocale: {
    en: "appCenterEn",
    "zh-CN": "appCenterZhCN"
  },
  name: "workspace-app-center",
  namespace: "appCenter",
  sourceRoot: "packages/workspace/app-center/src/ui"
});

export const appCenterEn = {
  actions: {
    cancel: "Cancel",
    deleteApp: "Delete app",
    exportApp: "Export",
    importApp: "Import",
    importAppTooltip:
      "Only valid Nextop app .zip packages are supported. You can export an app and import it here.",
    installApp: "Install",
    moreActions: "More actions",
    openApp: "Open",
    openAppFolder: "Open data folder",
    openAppPackageFolder: "Open app folder",
    modifyAppWithAgent: "Edit with agent",
    publishAppUpdate: "Republish",
    refreshCatalog: "Refresh catalog",
    replaceIcon: "Replace icon",
    retryApp: "Retry",
    updateApp: "Update",
    uninstallAndDeleteApp: "Uninstall and delete",
    uninstallApp: "Uninstall"
  },
  confirmations: {
    deleteAppDescription:
      "This removes the app from your local apps and deletes its app data.",
    deleteAppTitle: 'Delete "{{name}}"?',
    uninstallAppDescriptionLocal:
      "This uninstalls the app from this workspace and deletes this workspace's app data. The app stays in My apps.",
    uninstallAppDescriptionRecommended:
      "This uninstalls the app from this workspace and deletes this workspace's app data.",
    uninstallAppTitle: 'Uninstall "{{name}}"?',
    uninstallAndDeleteAppDescription:
      "This uninstalls the app, deletes its app data, and removes it from your local apps.",
    uninstallAndDeleteAppTitle: 'Uninstall and delete "{{name}}"?'
  },
  factory: {
    actions: {
      cancel: "Cancel",
      create: "Create app",
      delete: "Delete",
      fix: "Fix",
      publish: "Add to my apps",
      validate: "Validate"
    },
    labels: {
      agent: "Agent",
      appName: "App name",
      create: "Create app",
      jobs: "Creation queue",
      model: "Model",
      modelReasoning: "Model and thinking depth",
      prompt: "Prompt",
      reasoningEffort: "Thinking depth",
      review: "Review",
      templateInspirationPrefix: "Try these inspirations:",
      templates: "Start from"
    },
    messages: {
      factoryJobFailed:
        "App creation failed. Open the agent session or try Fix to view details.",
      loadingConfiguration: "Loading configuration...",
      loadingProviders: "Loading agent providers...",
      noAgentProviders: "No available agent providers.",
      noConfigurationOptions: "No configuration options available.",
      noModelOptions: "No models available.",
      noPermissionOptions: "No review options available.",
      noReasoningEffortOptions: "No thinking depth options available."
    },
    placeholders: {
      appName: "Name your app",
      prompt: "Describe the app to create"
    },
    prompts: {
      fixDefault: "Fix the draft so it passes validation."
    },
    permissionSemantics: {
      "accept-edits": {
        label: "Accept edits"
      },
      "ask-before-write": {
        label: "Ask for approval"
      },
      auto: {
        label: "Approve for me"
      },
      "full-access": {
        label: "Full access"
      },
      "locked-down": {
        label: "Don't ask"
      },
      unconfigurable: {
        label: "Fixed mode"
      }
    },
    templates: {
      lookup: {
        defaultName: "Answer Book",
        prompt:
          "Create an offline answer-book app for playful quick guidance. Let the user type a question, draw one random short answer from a built-in answer deck, show the answer prominently with a redraw action, and keep recent questions and draws in app data. Do not use external network or factual lookup APIs.",
        summary: "Offline random answers for user-entered questions.",
        title: "Answer book"
      },
      news: {
        defaultName: "News Brief",
        prompt:
          "Create a news reader app backed by user-configurable RSS or Atom feeds that can be fetched without API keys. On refresh, fetch all saved feeds once, parse and deduplicate items by link or title, and show a concise feed with source names, timestamps, saved topics, and a short brief view. Keep feed and topic preferences in app data, and make feed fetch failures visible and retryable.",
        summary: "RSS and Atom feeds, brief views, and saved topics.",
        title: "News"
      },
      gomoku: {
        defaultName: "Gomoku",
        prompt:
          "Create a local Gomoku game app. Render a 15 by 15 board, let two local players alternate black and white stones, detect five in a row horizontally, vertically, or diagonally, show the winner or draw state, and provide restart and undo controls. Keep recent match results and settings in app data, and do not depend on external network services.",
        summary: "Local two-player Gomoku with win detection.",
        title: "Gomoku"
      },
      system: {
        defaultName: "System Monitor",
        prompt:
          "Create a local system dashboard inspired by btop. Show CPU, memory, process, network, and disk usage in a dense readable layout. Refresh automatically, keep settings in app data, and avoid external network dependencies.",
        summary: "CPU, memory, network, process, and disk usage.",
        title: "System dashboard"
      },
      weather: {
        defaultName: "Weather Watch",
        prompt:
          "Create a weather lookup app backed by Open-Meteo APIs that can be fetched without API keys. Use Open-Meteo geocoding to search locations and Open-Meteo forecast data for current conditions, hourly forecasts, and daily forecasts. Let the user enter and save locations, keep saved locations in app data, refresh selected locations on demand, and clearly surface retryable refresh errors.",
        summary: "Current conditions and forecasts for saved locations.",
        title: "Weather"
      }
    },
    status: {
      canceled: "Canceled",
      failed: "Failed",
      generating: "Generating",
      preparing: "Preparing",
      published: "Published",
      queued: "Queued",
      ready: "Completed",
      validating: "Validating"
    }
  },
  comingSoonApps: {
    productCompetition: {
      category: "Product and design",
      description:
        "Compare competing products, extract positioning, and review product and design decisions.",
      name: "Competitive Analysis"
    },
    designReview: {
      category: "Product and design",
      description:
        "Review product flows, interface details, and design quality before release.",
      name: "Design Review"
    },
    groupChat: {
      category: "Productivity",
      description: "Get work done with your agents in group chat.",
      name: "Group Chat"
    },
    aiPpt: {
      category: "Office",
      description:
        "Create presentation outlines, slide structure, and polished decks with AI assistance.",
      name: "AI PPT"
    },
    aiDocument: {
      category: "Office",
      description:
        "Draft, rewrite, and organize workspace documents with AI assistance.",
      name: "AI Docs"
    },
    aiSheet: {
      category: "Office",
      description:
        "Build spreadsheet structures, analyze tables, and generate formulas with AI assistance.",
      name: "AI Sheets"
    },
    openCut: {
      category: "Content creation",
      description:
        "Edit videos on an open-source timeline with clips, cuts, and media tracks.",
      name: "Open Cut"
    },
    calendar: {
      category: "Productivity",
      description:
        "Track meetings, milestones, follow-ups, and shared workspace schedules.",
      name: "Calendar"
    },
    documentSummarizer: {
      category: "Productivity",
      description:
        "Summarize long documents into key points, action items, and concise briefs.",
      name: "Document Summarizer"
    }
  },
  comingSoonTags: {
    productCompetition: {
      primary: "Market",
      secondary: "Benchmark",
      tertiary: "Insights"
    },
    designReview: {
      primary: "UX",
      secondary: "Heuristics",
      tertiary: "Review"
    },
    groupChat: {
      primary: "Chat",
      secondary: "Team",
      tertiary: "Sync"
    },
    aiPpt: {
      primary: "Slides",
      secondary: "Outline",
      tertiary: "Deck"
    },
    aiDocument: {
      primary: "Writing",
      secondary: "Rewrite",
      tertiary: "Docs"
    },
    aiSheet: {
      primary: "Data",
      secondary: "Formula",
      tertiary: "Tables"
    },
    openCut: {
      primary: "Video",
      secondary: "Timeline",
      tertiary: "Editing"
    },
    calendar: {
      primary: "Schedule",
      secondary: "Meetings",
      tertiary: "Tasks"
    },
    documentSummarizer: {
      primary: "Summary",
      secondary: "Key points",
      tertiary: "Actions"
    }
  },
  categories: {
    contentCreation: "Content creation",
    office: "Office",
    productDesign: "Product and design",
    tools: "Productivity"
  },
  labels: {
    allApps: "All",
    appCategories: "App categories",
    appList: "Apps",
    appPlural: "Apps",
    appSingular: "App",
    failedCount: "{{count}} failed",
    installedAppsTitle: "{{count}} installed {{appLabel}}",
    installedCount: "{{count}} installed",
    myApps: "My apps",
    recommendedApps: "Recommended apps",
    runningCount: "{{count}} running",
    updateAvailable: "Update {{version}} available",
    version: "Version {{version}}"
  },
  messages: {
    appRuntimeFailed:
      "The app failed to start. Open its session or logs for details.",
    catalogFailed:
      "Remote app catalog is unavailable. Local apps are still available.",
    catalogLoading: "Loading remote app catalog...",
    empty: "No apps installed yet",
    myAppsEmpty: "Imported and created apps will appear here.",
    recommendedAppsEmpty: "No recommended apps available."
  },
  status: {
    comingSoon: "Coming soon",
    failed: "Failed",
    installing: "Installing",
    preparing: "Preparing",
    running: "Running",
    starting: "Starting",
    stopping: "Stopping"
  },
  title: "Applications"
} as const satisfies I18nDictionary;

export const appCenterZhCN = {
  actions: {
    cancel: "取消",
    deleteApp: "删除应用",
    exportApp: "导出",
    importApp: "导入",
    importAppTooltip:
      "仅支持符合规范的 Nextop 应用 .zip 包。你可以先导出应用，再在这里导入。",
    installApp: "安装",
    moreActions: "更多操作",
    openApp: "打开",
    openAppFolder: "打开数据目录",
    openAppPackageFolder: "打开应用目录",
    modifyAppWithAgent: "用智能体编辑",
    publishAppUpdate: "重新发布",
    refreshCatalog: "刷新目录",
    replaceIcon: "替换图标",
    retryApp: "重试",
    updateApp: "更新",
    uninstallAndDeleteApp: "卸载并删除",
    uninstallApp: "卸载"
  },
  confirmations: {
    deleteAppDescription: "这会从本地应用列表删除该应用，并删除它的应用数据。",
    deleteAppTitle: "删除“{{name}}”？",
    uninstallAppDescriptionLocal:
      "这会从当前工作区卸载该应用，并删除此工作区中的应用数据。应用本体仍保留在我的应用中。",
    uninstallAppDescriptionRecommended:
      "这会从当前工作区卸载该应用，并删除此工作区中的应用数据。",
    uninstallAppTitle: "卸载“{{name}}”？",
    uninstallAndDeleteAppDescription:
      "这会卸载该应用、删除应用数据，并从本地应用列表移除。",
    uninstallAndDeleteAppTitle: "卸载并删除“{{name}}”？"
  },
  factory: {
    actions: {
      cancel: "取消",
      create: "创建应用",
      delete: "删除",
      fix: "修复",
      publish: "添加至我的应用",
      validate: "验证"
    },
    labels: {
      agent: "Agent",
      appName: "应用名称",
      create: "创建应用",
      jobs: "创建队列",
      model: "模型",
      modelReasoning: "模型与思考深度",
      prompt: "提示词",
      reasoningEffort: "思考深度",
      review: "审查",
      templateInspirationPrefix: "试试这些灵感：",
      templates: "选择起点"
    },
    messages: {
      factoryJobFailed: "应用创建失败。打开 Agent 会话或使用修复操作查看详情。",
      loadingConfiguration: "正在加载配置...",
      loadingProviders: "正在加载 Agent Provider...",
      noAgentProviders: "暂无可用的 Agent Provider。",
      noConfigurationOptions: "暂无可用配置项。",
      noModelOptions: "暂无可用模型。",
      noPermissionOptions: "暂无可用的审查选项。",
      noReasoningEffortOptions: "暂无可用的思考深度选项。"
    },
    placeholders: {
      appName: "输入应用名称",
      prompt: "描述要创建的应用"
    },
    prompts: {
      fixDefault: "修复当前草稿，让它通过验证。"
    },
    permissionSemantics: {
      "accept-edits": {
        label: "接受编辑"
      },
      "ask-before-write": {
        label: "请求批准"
      },
      auto: {
        label: "代我批准"
      },
      "full-access": {
        label: "完全访问"
      },
      "locked-down": {
        label: "不再询问"
      },
      unconfigurable: {
        label: "固定模式"
      }
    },
    templates: {
      lookup: {
        defaultName: "答案之书",
        prompt:
          "创建一个离线的答案之书应用，用于给用户输入的问题提供轻量随机指引。允许用户输入问题，从内置答案卡组里随机抽取一句短答案，突出展示答案，并提供重新抽取操作；把最近问题和抽取记录保存在应用数据目录。不要依赖外部网络或事实查询 API。",
        summary: "面向用户输入问题的离线随机答案。",
        title: "答案之书"
      },
      news: {
        defaultName: "新闻简报",
        prompt:
          "创建一个新闻阅读应用，使用用户可配置且无需 API Key 的 RSS 或 Atom feed 作为数据源。刷新时一次性抓取所有已保存 feed，解析并按链接或标题去重，展示简洁信息流、来源名称、时间、已保存主题和简报视图；把 feed 和主题偏好保存在应用数据目录，并让 feed 抓取失败状态可见且可重试。",
        summary: "RSS 和 Atom 信息流、简报视图和关注主题。",
        title: "新闻"
      },
      gomoku: {
        defaultName: "五子棋",
        prompt:
          "创建一个本地五子棋小游戏应用。渲染 15 x 15 棋盘，支持两名本地玩家轮流落黑白棋，检测横向、纵向和斜向五子连珠，展示胜负或平局状态，并提供重新开始和悔棋控制。把最近对局结果和设置保存在应用数据目录，不依赖外部网络服务。",
        summary: "带胜负检测的本地双人五子棋。",
        title: "五子棋"
      },
      system: {
        defaultName: "系统监控",
        prompt:
          "创建一个类似 btop 的本地系统看板。用紧凑清晰的布局展示 CPU、内存、进程、网络和磁盘占用；自动刷新，把设置保存在应用数据目录，并避免依赖外部网络。",
        summary: "CPU、内存、网络、进程和磁盘占用。",
        title: "系统看板"
      },
      weather: {
        defaultName: "天气查询",
        prompt:
          "创建一个天气查询应用，使用无需 API Key 的 Open-Meteo 数据源。用 Open-Meteo geocoding 搜索地点，用 Open-Meteo forecast 获取当前天气、小时预报和每日预报；允许用户输入并保存地点，把保存的地点放在应用数据目录，支持按需刷新选中地点，并清楚展示可重试的刷新失败状态。",
        summary: "保存地点的当前天气和预报。",
        title: "天气"
      }
    },
    status: {
      canceled: "已取消",
      failed: "失败",
      generating: "生成中",
      preparing: "准备中",
      published: "已发布",
      queued: "排队中",
      ready: "已完成",
      validating: "验证中"
    }
  },
  comingSoonApps: {
    productCompetition: {
      category: "产品与设计",
      description: "对比竞品定位、功能路径与设计表达，沉淀产品和设计决策依据。",
      name: "竞品分析"
    },
    designReview: {
      category: "产品与设计",
      description: "评审产品流程、界面细节和设计质量，帮助发布前发现问题。",
      name: "设计评审"
    },
    groupChat: {
      category: "工具",
      description: "在群里跟你的 Agents 一起干活",
      name: "群聊"
    },
    aiPpt: {
      category: "办公",
      description: "用 AI 辅助生成演示大纲、页面结构和成稿内容。",
      name: "AI PPT"
    },
    aiDocument: {
      category: "办公",
      description: "用 AI 辅助起草、改写和整理工作区文档。",
      name: "AI 文档"
    },
    aiSheet: {
      category: "办公",
      description: "用 AI 辅助搭建表格结构、分析数据并生成公式。",
      name: "AI 表格"
    },
    openCut: {
      category: "内容创作",
      description: "开源时间线剪辑工具，用于编排素材、裁切片段和编辑视频轨道。",
      name: "Open Cut"
    },
    calendar: {
      category: "工具",
      description: "管理会议、里程碑、跟进事项和共享日程。",
      name: "Calendar"
    },
    documentSummarizer: {
      category: "工具",
      description: "将长文档提炼为关键结论、行动项和简明摘要。",
      name: "文档总结器"
    }
  },
  comingSoonTags: {
    productCompetition: {
      primary: "市场",
      secondary: "对标",
      tertiary: "洞察"
    },
    designReview: {
      primary: "体验",
      secondary: "准则",
      tertiary: "评审"
    },
    groupChat: {
      primary: "团队",
      secondary: "协同",
      tertiary: "工作"
    },
    aiPpt: {
      primary: "幻灯片",
      secondary: "大纲",
      tertiary: "成稿"
    },
    aiDocument: {
      primary: "写作",
      secondary: "改写",
      tertiary: "文档"
    },
    aiSheet: {
      primary: "数据",
      secondary: "公式",
      tertiary: "表格"
    },
    openCut: {
      primary: "视频",
      secondary: "时间线",
      tertiary: "剪辑"
    },
    calendar: {
      primary: "日程",
      secondary: "会议",
      tertiary: "任务"
    },
    documentSummarizer: {
      primary: "摘要",
      secondary: "要点",
      tertiary: "行动项"
    }
  },
  categories: {
    contentCreation: "内容创作",
    office: "办公",
    productDesign: "产品与设计",
    tools: "工具"
  },
  labels: {
    allApps: "全部",
    appCategories: "应用分类",
    appList: "应用",
    appPlural: "App",
    appSingular: "App",
    failedCount: "{{count}} 个失败",
    installedAppsTitle: "已安装 {{count}} 个 {{appLabel}}",
    installedCount: "已安装 {{count}} 个",
    myApps: "我的应用",
    recommendedApps: "推荐应用",
    runningCount: "{{count}} 个运行中",
    updateAvailable: "可更新到 {{version}}",
    version: "版本 {{version}}"
  },
  messages: {
    appRuntimeFailed: "应用启动失败。请打开会话或日志查看详情。",
    catalogFailed: "无法加载远程应用目录，本地应用仍可用。",
    catalogLoading: "正在加载远程应用目录...",
    empty: "还没有安装应用",
    myAppsEmpty: "导入或创建的应用会显示在这里",
    recommendedAppsEmpty: "暂无推荐应用"
  },
  status: {
    comingSoon: "敬请期待",
    failed: "失败",
    installing: "安装中",
    preparing: "准备中",
    running: "运行中",
    starting: "启动中",
    stopping: "停止中"
  },
  title: "应用"
} as const satisfies I18nDictionary;

export type AppCenterI18nKey = string;

export type AppCenterI18nRuntime = I18nRuntime<AppCenterI18nKey>;

const appCenterDefaults: Record<AppCenterI18nLocale, I18nDictionary> = {
  en: appCenterEn,
  "zh-CN": appCenterZhCN
};

export const appCenterI18nResources = {
  en: {
    [appCenterI18nNamespace]: appCenterDefaults.en
  },
  "zh-CN": {
    [appCenterI18nNamespace]: appCenterDefaults["zh-CN"]
  }
} as const satisfies Record<AppCenterI18nLocale, I18nDictionary>;

const defaultAppCenterI18n = createI18nRuntime({
  dictionaries: [appCenterI18nResources.en]
});

export function createAppCenterI18nRuntime(
  runtime: I18nRuntime<string> | undefined
): AppCenterI18nRuntime {
  return createScopedI18nRuntime<AppCenterI18nKey>(
    runtime ?? defaultAppCenterI18n,
    appCenterI18nNamespace
  );
}
