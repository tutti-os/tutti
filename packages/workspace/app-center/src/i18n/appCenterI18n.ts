import {
  createI18nRuntime,
  createScopedI18nRuntime,
  createScopedLocaleObjectsI18nModuleManifest,
  type I18nDictionary,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";

type AppCenterI18nLocale = "en" | "zh-CN";

export const appCenterI18nNamespace = "appCenter";
export const tuttiI18nModule = createScopedLocaleObjectsI18nModuleManifest({
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
      "Only valid Tutti app .zip packages are supported. You can export an app and import it here.",
    installApp: "Install",
    loadUnpackedApp: "Load unpacked",
    loadUnpackedAppTooltip:
      "Select a Tutti app directory or a project root with .tutti/dev-app.",
    moreActions: "More actions",
    openApp: "Open",
    openAppFolder: "Open data folder",
    openAppPackageFolder: "Open app folder",
    modifyAppWithAgent: "Edit with agent",
    publishAppUpdate: "Republish",
    refreshCatalog: "Refresh catalog",
    reloadLocalApp: "Reload",
    replaceIcon: "Replace icon",
    retryApp: "Retry",
    restartAndOpenApp: "Restart and open",
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
    updateAppTitle: 'Update "{{name}}"?',
    updateRunningAppDescription:
      "The app will restart after the update finishes to apply changes.",
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
      jobs: "In progress",
      model: "Model",
      modelReasoning: "Model and thinking depth",
      prompt: "Prompt",
      reasoningEffort: "Thinking depth",
      review: "Review",
      templateInspirationPrefix: "Try these inspirations:",
      templates: "Start from"
    },
    messages: {
      factoryJobFailed: "Creation failed. Open the agent session for details.",
      factoryJobFailedWithFix:
        "Creation failed. Open the agent session or use Fix for details.",
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
      lovart: {
        defaultName: "Lovart Studio",
        prompt:
          "Create a local AI brand design studio inspired by Lovart. The app should turn one brand or campaign brief into a coordinated asset board. Provide a concise brief form for brand name, audience, tone, colors, deliverables, and constraints; generate an editable creative direction with palette, typography notes, messaging angles, and art direction; create a checklist of assets such as logo concepts, hero image, product mockups, social posts, ad banners, landing page sections, and short video storyboard frames; produce copy-ready image prompts for each asset with aspect ratio, style, and negative prompt guidance; render the assets in a canvas-like grid with status, notes, and iteration history; let users refine a selected asset with natural-language instructions; keep projects, briefs, generated prompts, notes, and asset states in app data. Use mock generated thumbnails locally unless a host-provided image generation API is available, and clearly show retryable generation errors.",
        summary:
          "Brand briefs, coordinated asset boards, and prompt workflows.",
        title: "Lovart Studio"
      },
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
  catalogApps: {
    agentClaudeCode: {
      description:
        "Start Claude Code in this workspace with access to shared context, files, and apps.",
      name: "Claude Code"
    },
    agentCodex: {
      description:
        "Start Codex in this workspace with access to shared context, files, and apps.",
      name: "Codex"
    },
    issueManager: {
      description: "Manage workspace tasks and runs.",
      name: "Task Manager"
    }
  },
  comingSoonApps: {
    productCompetition: {
      category: "Product design",
      description:
        "Compare competitor positioning, features, and experience to support product decisions.",
      name: "Competitor Analysis"
    },
    designReview: {
      category: "Product design",
      description:
        "Review flows, interfaces, and experience issues before release.",
      name: "Design Review"
    },
    groupChat: {
      category: "Other tools",
      description: "Collaborate with multiple agents in a group chat.",
      name: "Group Chat"
    },
    aiPpt: {
      category: "Daily office",
      description:
        "Generate presentation outlines, slide structure, and first-draft content.",
      name: "AI PPT"
    },
    aiDocument: {
      category: "Daily office",
      description: "Draft, rewrite, and organize documents.",
      name: "AI Document"
    },
    aiSheet: {
      category: "Daily office",
      description: "Build spreadsheets and analyze data with AI assistance.",
      name: "AI Spreadsheet"
    },
    openCut: {
      category: "Content creation",
      description:
        "Open-source video editor with media arrangement and timeline editing.",
      name: "Open Cut"
    }
  },
  categories: {
    contentCreation: "Content creation",
    office: "Daily office",
    productDesign: "Product design",
    tools: "Other tools"
  },
  labels: {
    allApps: "All",
    appCategories: "App categories",
    appList: "App Center",
    appPlural: "Apps",
    appSingular: "App",
    communityApps: "Community apps",
    failedCount: "{{count}} failed",
    installedAppsTitle: "{{count}} installed {{appLabel}}",
    installedCount: "{{count}} installed",
    localDev: "local-dev",
    myApps: "My apps",
    recommendedApps: "Official apps",
    runningCount: "{{count}} running",
    updateAvailable: "Update to {{version}}",
    version: "Version {{version}}"
  },
  localDev: {
    repairDialog: {
      confirm: "Ask Agent to fix",
      description: "Ask Agent to fix it with one click.",
      title: ".tutti files not found"
    },
    repairPrompt:
      'Load the skill https://github.com/tutti-os/tutti-agent-skills/tree/main/plugins/tutti/skills/tutti-workspace-app-factory and adapt project directory "{{cwd}}" into a Tutti local debug app. Generate .tutti/dev-app/; bootstrap.sh must read the host-injected TUTTI_APP_HOST and TUTTI_APP_PORT, and must not hard-code a port.'
  },
  messages: {
    appRuntimeFailed:
      "The app failed to start. Open its session or logs for details.",
    catalogFailed:
      "Remote app catalog is unavailable. Local apps are still available.",
    catalogLoading: "Loading remote app catalog...",
    empty: "No apps installed yet",
    communityAppsEmpty: "No community apps available.",
    myAppsEmpty: "Imported and created apps will appear here.",
    recommendedAppsEmpty: "No official apps available."
  },
  sources: {
    developer: "Developer:",
    developerCount: "{{count}} developers",
    developerMenuLabel: "Developer: {{name}}",
    githubRepository: "GitHub repository",
    official: "Official",
    title: "Source"
  },
  status: {
    comingSoon: "Coming soon",
    failed: "Failed",
    installProgress: {
      downloadedOfTotal: "{{downloaded}} / {{total}}",
      downloading: "Downloading…",
      installing: "Installing…",
      progressAria: "App install progress",
      starting: "Starting…"
    },
    installing: "Installing",
    installedPendingRestart: "New version installed. Restart to apply.",
    preparing: "Preparing",
    running: "Running",
    starting: "Starting",
    stopping: "Stopping",
    unavailable: "Unavailable"
  },
  title: "App Center"
} as const satisfies I18nDictionary;

export const appCenterZhCN = {
  actions: {
    cancel: "取消",
    deleteApp: "删除应用",
    exportApp: "导出",
    importApp: "导入",
    importAppTooltip:
      "仅支持符合规范的 Tutti 应用 .zip 包。你可以先导出应用，再在这里导入。",
    installApp: "安装",
    loadUnpackedApp: "加载未打包的本地程序",
    loadUnpackedAppTooltip:
      "选择 Tutti 应用目录，或包含 .tutti/dev-app 的项目根目录。",
    moreActions: "更多操作",
    openApp: "打开",
    openAppFolder: "打开数据目录",
    openAppPackageFolder: "打开应用目录",
    modifyAppWithAgent: "用智能体编辑",
    publishAppUpdate: "重新发布",
    refreshCatalog: "刷新目录",
    reloadLocalApp: "重新加载",
    replaceIcon: "替换图标",
    retryApp: "重试",
    restartAndOpenApp: "重启并打开",
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
    updateAppTitle: "更新“{{name}}”？",
    updateRunningAppDescription: "更新完成后会重启应用以应用更改。",
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
      jobs: "进行中",
      model: "模型",
      modelReasoning: "模型与思考深度",
      prompt: "提示词",
      reasoningEffort: "思考深度",
      review: "审查",
      templateInspirationPrefix: "试试这些灵感：",
      templates: "选择起点"
    },
    messages: {
      factoryJobFailed: "创建失败，打开 Agent 会话查看详情。",
      factoryJobFailedWithFix: "创建失败，打开 Agent 会话或使用修复查看详情。",
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
        label: "替我审批"
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
      lovart: {
        defaultName: "Lovart Studio",
        prompt:
          "创建一个受 Lovart 启发的本地 AI 品牌设计工作室应用。应用需要把一句品牌或营销活动 brief 转成一组统一风格的资产看板。提供简洁的 brief 表单，字段包括品牌名、受众、语气、颜色、交付物和约束；生成可编辑的创意方向，包含色板、字体建议、信息表达角度和视觉方向；创建资产清单，例如 logo 概念、主视觉、产品 mockup、社媒帖子、广告横幅、落地页区块和短视频分镜；为每个资产生成可复制的图片提示词，包含画幅比例、风格和负面提示词建议；用类似画布的网格展示资产、状态、备注和迭代历史；允许用户用自然语言细化选中的资产；把项目、brief、生成提示词、备注和资产状态保存在应用数据目录。没有宿主提供的图片生成 API 时使用本地 mock 缩略图，并清楚展示可重试的生成失败状态。",
        summary: "品牌 brief、统一资产看板和提示词工作流。",
        title: "Lovart Studio"
      },
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
  catalogApps: {
    agentClaudeCode: {
      description: "启动 Claude Code，处理当前工作区任务。",
      name: "Claude Code"
    },
    agentCodex: {
      description: "启动 Codex，处理当前工作区任务。",
      name: "Codex"
    },
    issueManager: {
      description: "管理工作区任务和运行记录。",
      name: "任务管理"
    }
  },
  comingSoonApps: {
    productCompetition: {
      category: "产品设计",
      description: "对比竞品定位、功能和体验，辅助产品决策",
      name: "竞品分析"
    },
    designReview: {
      category: "产品设计",
      description: "检查流程、界面和体验问题",
      name: "设计评审"
    },
    groupChat: {
      category: "其他工具",
      description: "在群里和多个 Agent 一起协作",
      name: "群聊"
    },
    aiPpt: {
      category: "日常办公",
      description: "生成演示大纲、页面结构和初稿内容",
      name: "AI PPT"
    },
    aiDocument: {
      category: "日常办公",
      description: "起草、改写和整理文档",
      name: "AI 文档"
    },
    aiSheet: {
      category: "日常办公",
      description: "用 AI 辅助搭建表格、分析数据",
      name: "AI 表格"
    },
    openCut: {
      category: "内容创作",
      description: "开源视频剪辑工具，支持素材编排和时间线编辑",
      name: "Open Cut"
    }
  },
  categories: {
    contentCreation: "内容创作",
    office: "日常办公",
    productDesign: "产品设计",
    tools: "其他工具"
  },
  labels: {
    allApps: "全部",
    appCategories: "应用分类",
    appList: "应用中心",
    appPlural: "App",
    appSingular: "App",
    communityApps: "社区应用",
    failedCount: "{{count}} 个失败",
    installedAppsTitle: "已安装 {{count}} 个 {{appLabel}}",
    installedCount: "已安装 {{count}} 个",
    localDev: "本地调试",
    myApps: "我的应用",
    recommendedApps: "官方应用",
    runningCount: "{{count}} 个运行中",
    updateAvailable: "更新到 {{version}}",
    version: "版本 {{version}}"
  },
  localDev: {
    repairDialog: {
      confirm: "让 Agent 修复",
      description: "可一键让 Agent 为你修复。",
      title: "目录未识别到 .tutti 文件"
    },
    repairPrompt:
      "加载 skill https://github.com/tutti-os/tutti-agent-skills/tree/main/plugins/tutti/skills/tutti-workspace-app-factory，将项目目录“{{cwd}}”适配成本地调试 Tutti 应用。生成 .tutti/dev-app/；bootstrap.sh 必须读取宿主注入的 TUTTI_APP_HOST 和 TUTTI_APP_PORT，不要硬编码端口。"
  },
  messages: {
    appRuntimeFailed: "应用启动失败。请打开会话或日志查看详情。",
    catalogFailed: "无法加载远程应用目录，本地应用仍可用。",
    catalogLoading: "正在加载远程应用目录...",
    empty: "还没有安装应用",
    communityAppsEmpty: "暂无社区应用",
    myAppsEmpty: "导入或创建的应用会显示在这里",
    recommendedAppsEmpty: "暂无官方应用"
  },
  sources: {
    developer: "开发者：",
    developerCount: "{{count}} 位开发者",
    developerMenuLabel: "开发者：{{name}}",
    githubRepository: "GitHub 仓库",
    official: "官方",
    title: "来源"
  },
  status: {
    comingSoon: "敬请期待",
    failed: "失败",
    installProgress: {
      downloadedOfTotal: "{{downloaded}} / {{total}}",
      downloading: "正在下载…",
      installing: "正在安装…",
      progressAria: "应用安装进度",
      starting: "正在启动…"
    },
    installing: "安装中",
    installedPendingRestart: "新版已安装，重启后生效",
    preparing: "准备中",
    running: "运行中",
    starting: "启动中",
    stopping: "停止中",
    unavailable: "不可用"
  },
  title: "应用中心"
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
