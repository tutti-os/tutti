import {
  createI18nRuntime,
  createScopedI18nRuntime,
  createScopedLocaleObjectsI18nModuleManifest,
  type I18nDictionary,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";

type IssueManagerI18nLocale = "en" | "zh-CN";

export const issueManagerI18nNamespace = "issueManager";
export const issueManagerI18nModule =
  createScopedLocaleObjectsI18nModuleManifest({
    localeObjectByLocale: {
      en: "issueManagerEn",
      "zh-CN": "issueManagerZhCN"
    },
    name: "workspace-issue-manager",
    namespace: issueManagerI18nNamespace,
    sourceRoot: "packages/workspace/issue-manager/src"
  });

const issueManagerEn = {
  actions: {
    add: "Add",
    addReferences: "Add references",
    addSubtask: "Add sub-issue",
    acceptTask: "Accept",
    askAgentToBreakdown: "Break down",
    askAgentToRun: "Run with agent",
    cancel: "Cancel",
    clearSearch: "Clear search",
    collapseIssueList: "Collapse issue list",
    copyShareLink: "Copy share link",
    createIssue: "New issue",
    createTask: "Create issue",
    createTopic: "New topic",
    delete: "Delete",
    deleteIssue: "Delete issue",
    deleteTask: "Delete issue",
    edit: "Edit",
    editIssue: "Edit issue",
    editTask: "Edit issue",
    editTopic: "Edit topic",
    expandIssueList: "Expand issue list",
    inviteCollaborator: "Invite collaborator",
    insertReferences: "Insert references",
    moreActions: "More actions",
    openAgentSession: "Open agent session",
    openReference: "Open",
    refresh: "Refresh",
    referenceWorkspaceFiles: "Reference files",
    rejectTask: "Reject",
    removeReference: "Remove",
    runTask: "Run issue",
    saveIssue: "Save issue",
    saveSubtask: "Save sub-issue",
    saveTask: "Save issue",
    pinTopic: "Pin",
    saveTopic: "Save topic",
    unpinTopic: "Unpin",
    uploadFiles: "Upload files",
    uploadFolder: "Upload folder"
  },
  composer: {
    issueContentPlaceholder: "Describe the issue, goals, or context.",
    issueTitlePlaceholder: "Issue title",
    subtaskContentPlaceholder:
      "Add the sub-issue goal, execution approach, and acceptance criteria.",
    subtaskTitlePlaceholder: "Enter a sub-issue title",
    taskContentPlaceholder:
      "Describe the executable issue and expected result.",
    taskTitlePlaceholder: "Issue title"
  },
  confirmations: {
    deleteIssue: "Delete this issue?",
    deleteTask: "Delete this issue?",
    deleteTopic: "Delete this topic?"
  },
  dockLabel: "Issues",
  emptyState:
    "Create an issue, add the goal and references, then let Agent run",
  labels: {
    allStatus: "All",
    content: "Content",
    contextReferences: "Context references",
    createTopicDialogTitle: "New topic",
    createdAt: "Created",
    creator: "Creator",
    customExecutionDirectory: "Custom directory",
    description: "Description",
    executionOutputs: "Execution outputs",
    issueDetails: "Issue details",
    issueList: "Issues",
    latestRunStatus: "Latest execution status",
    outputs: "Outputs",
    priority: "Priority",
    provider: "Provider",
    recentRuns: "Recent runs",
    requirementDescription: "Requirements",
    resizeIssueList: "Resize issue list",
    searchIssues: "Search issues",
    scrollStatusTabsLeft: "Scroll status tabs left",
    scrollStatusTabsRight: "Scroll status tabs right",
    status: "Status",
    subtasks: "Sub-issues",
    taskAcceptance: "Sub-issue pending acceptance",
    topic: "Topic",
    topicDefault: "Default",
    topicSummary: "Topic summary",
    topicTitle: "Topic title",
    editTopicDialogTitle: "Edit topic",
    title: "Title",
    updatedAt: "Updated",
    taskCount: "{{count}} sub-issues",
    taskDetails: "Issue details",
    taskList: "Issues",
    temporaryExecutionDirectory: "Temporary directory"
  },
  messages: {
    clipboardUnavailable: "Clipboard is unavailable.",
    agentSessionOpenFailed: "Couldn't open the agent session.",
    breakdownOpenFailed: "Couldn't open the agent task breakdown.",
    breakdownUnavailable: "Agent task breakdown is unavailable.",
    copyShareLinkFailed: "Couldn't copy the share link.",
    copiedShareLink: "Share link copied.",
    issueDeleteFailed: "Couldn't delete the issue.",
    issueRefreshFailed: "Couldn't refresh issues.",
    issueSaveFailed: "Couldn't save the issue.",
    issueDeleted: "Issue deleted.",
    issueSaved: "Issue saved.",
    issueContentEmpty: "No issue description yet",
    noExecutionOutputs: "No execution outputs yet",
    noExecutionStatus: "No execution records yet",
    noIssueReferences: "No issue references yet",
    noIssuesForFilterBody:
      "Try another filter, or create a new issue to get things started",
    noIssuesForFilterTitle: "No issues match the current filter",
    noIssues: "No issues yet",
    noAgentProviders: "No available agent providers.",
    noOutputs: "No outputs yet",
    noRecentRuns: "No runs yet",
    taskContentEmpty: "No issue description yet",
    taskAcceptanceHint: "Accept to complete; reject to return to To run.",
    noTaskReferences: "No issue references yet",
    noTasksForIssueBody:
      "Create the first sub-issue for this issue and let an agent or yourself execute it",
    noSubtasksForIssue:
      "You can continue breaking down this item by adding sub-issues",
    noTasks: "No issues yet",
    refreshingIssues: "Refreshing issues...",
    titleRequired: "Enter a title before saving.",
    runExitCode: "Codex exited with code {{code}}.",
    runCompleted: "Run completed.",
    runFailed: "Run failed",
    runStarted: "Run started.",
    runStatusMissing:
      "Terminal exited before the issue run produced a status marker.",
    runTimedOut: "Issue run timed out while waiting for Codex output.",
    referenceRemoveFailed: "Couldn't remove the reference.",
    taskDeleteFailed: "Couldn't delete the issue.",
    taskSaveFailed: "Couldn't save the issue.",
    taskDeleted: "Issue deleted.",
    taskSaved: "Issue saved.",
    topicCreateFailed: "Couldn't create the topic.",
    topicDeleteDefaultForbidden: "The default topic can't be deleted.",
    topicDeleteFailed: "Couldn't delete the topic.",
    topicDeleteNotEmpty:
      "Move or delete the issues in this topic before deleting it.",
    topicDeleteNotFound: "This topic no longer exists.",
    topicListEmpty: "No issue topics are available.",
    topicUpdateFailed: "Couldn't update the topic.",
    uploadTypeConflict: "Upload target contains conflicting entry types.",
    workspacePathUnavailable: "Workspace path is unavailable."
  },
  priority: {
    high: "High",
    low: "Low",
    medium: "Medium"
  },
  referencePicker: {
    browse: "Browse",
    confirm: "Use selected references",
    emptyDirectory: "This folder is empty.",
    emptySearch: "No matching files or folders.",
    loading: "Loading...",
    previewBinary: "This file looks like binary content.",
    previewDecodeFailed: "This file couldn't be decoded as UTF-8 text.",
    previewError: "Couldn't load a preview.",
    previewFileTooLarge: "This file is larger than {{maxSize}}.",
    previewFolder: "Folder preview is not available.",
    previewLoading: "Loading preview...",
    previewTextTooLarge: "This text file is larger than {{maxSize}}.",
    previewUnavailable: "Preview is not available in this workspace.",
    previewUnsupported: "This file type can't be previewed here.",
    searchPlaceholder: "Search files and folders",
    selectedCount: "{{count}} selected",
    title: "Pick workspace references"
  },
  richTextAt: {
    loading: "Loading...",
    noMatches: "No matches"
  },
  run: {
    failedSummaryFallback: "Run failed",
    outputDirectory: "Output directory",
    requester: "Requester",
    status: "Run status",
    summary: "Summary"
  },
  runPrompts: {
    breakdownIntro: "Break this issue reference down into executable tasks.",
    executeIntro: "Handle this issue reference."
  },
  status: {
    canceled: "Canceled",
    completed: "Completed",
    failed: "Failed",
    inProgress: "Progress started",
    notStarted: "To run",
    pendingAcceptance: "Pending",
    running: "Running",
    unknown: "Unknown"
  },
  title: "Issue Center"
} as const satisfies I18nDictionary;

const issueManagerZhCN = {
  actions: {
    add: "添加",
    addReferences: "添加引用",
    addSubtask: "添加子事项",
    acceptTask: "验证通过",
    askAgentToBreakdown: "Agent 拆解任务",
    askAgentToRun: "Agent 执行",
    cancel: "取消",
    clearSearch: "清空搜索",
    collapseIssueList: "收起事项列表",
    copyShareLink: "复制分享链接",
    createIssue: "新建事项",
    createTask: "新建事项",
    createTopic: "新建主题",
    delete: "删除",
    deleteIssue: "删除事项",
    deleteTask: "删除事项",
    edit: "编辑",
    editIssue: "编辑事项",
    editTask: "编辑事项",
    editTopic: "编辑主题",
    expandIssueList: "展开事项列表",
    inviteCollaborator: "邀请协作者",
    insertReferences: "插入引用",
    moreActions: "更多操作",
    openAgentSession: "打开 Agent 会话",
    openReference: "打开",
    refresh: "刷新",
    referenceWorkspaceFiles: "引用文件",
    rejectTask: "驳回",
    removeReference: "移除",
    runTask: "运行事项",
    saveIssue: "保存事项",
    saveSubtask: "保存子事项",
    saveTask: "保存事项",
    pinTopic: "置顶",
    saveTopic: "保存主题",
    unpinTopic: "取消置顶",
    uploadFiles: "上传文件",
    uploadFolder: "上传文件夹"
  },
  composer: {
    issueContentPlaceholder: "补充这个事项的背景、目标或上下文",
    issueTitlePlaceholder: "事项标题",
    subtaskContentPlaceholder: "补充子事项目标、执行方式和验收标准",
    subtaskTitlePlaceholder: "请输入子事项标题",
    taskContentPlaceholder: "描述这个事项的执行要求和预期结果。",
    taskTitlePlaceholder: "事项标题"
  },
  confirmations: {
    deleteIssue: "确定删除这个事项吗？",
    deleteTask: "确定删除这个事项吗？",
    deleteTopic: "确定删除这个主题吗？"
  },
  dockLabel: "事项",
  emptyState: "新建事项，补充需求描述和相关文件，即可让 Agent 执行",
  labels: {
    allStatus: "全部",
    content: "内容",
    contextReferences: "上下文引用",
    createTopicDialogTitle: "新建主题",
    createdAt: "创建时间",
    creator: "创建者",
    customExecutionDirectory: "自定义目录",
    description: "描述",
    executionOutputs: "执行产物",
    issueDetails: "事项详情",
    issueList: "事项",
    latestRunStatus: "最新执行状态",
    outputs: "输出产物",
    priority: "优先级",
    provider: "Provider",
    recentRuns: "最近运行",
    requirementDescription: "需求描述",
    resizeIssueList: "调整事项列表宽度",
    searchIssues: "搜索事项",
    scrollStatusTabsLeft: "向左滚动状态标签",
    scrollStatusTabsRight: "向右滚动状态标签",
    status: "状态",
    subtasks: "子事项",
    taskAcceptance: "任务待验收",
    topic: "主题",
    topicDefault: "默认",
    topicSummary: "主题概要",
    topicTitle: "主题标题",
    editTopicDialogTitle: "编辑主题",
    title: "标题",
    updatedAt: "更新时间",
    taskCount: "{{count}} 个子事项",
    taskDetails: "事项详情",
    taskList: "事项",
    temporaryExecutionDirectory: "临时目录"
  },
  messages: {
    clipboardUnavailable: "当前环境无法访问剪贴板。",
    agentSessionOpenFailed: "打开 Agent 会话失败。",
    breakdownOpenFailed: "打开 Agent 任务拆解失败。",
    breakdownUnavailable: "当前环境暂不支持 Agent 任务拆解。",
    copyShareLinkFailed: "复制分享链接失败。",
    copiedShareLink: "已复制分享链接。",
    issueDeleteFailed: "删除事项失败。",
    issueRefreshFailed: "刷新事项列表失败。",
    issueSaveFailed: "保存事项失败。",
    issueDeleted: "事项已删除。",
    issueSaved: "事项已保存。",
    issueContentEmpty: "这个事项还没有描述",
    noExecutionOutputs: "暂无执行产物",
    noExecutionStatus: "暂无执行记录",
    noIssueReferences: "这个事项还没有引用",
    noIssuesForFilterBody: "试试切换筛选条件，或者新建一个事项",
    noIssuesForFilterTitle: "当前筛选条件下暂无事项",
    noIssues: "还没有事项",
    noAgentProviders: "暂无可用的 Agent Provider。",
    noOutputs: "还没有输出产物",
    noRecentRuns: "还没有运行记录",
    taskContentEmpty: "这个事项还没有描述",
    taskAcceptanceHint: "验证后完成，驳回后回到待启动。",
    noTaskReferences: "这个事项还没有引用",
    noTasksForIssueBody:
      "为这个事项创建第一个子事项，然后交给 Agent 或你自己执行",
    noSubtasksForIssue: "你可以围绕当前事项继续添加子事项",
    noTasks: "还没有事项",
    refreshingIssues: "正在刷新事项列表...",
    titleRequired: "请先填写标题后再保存。",
    runExitCode: "Codex 以退出码 {{code}} 结束。",
    runCompleted: "运行已完成。",
    runFailed: "运行失败",
    runStarted: "运行已开始。",
    runStatusMissing: "终端在写入运行状态前就退出了。",
    runTimedOut: "等待 Codex 输出超时。",
    referenceRemoveFailed: "移除引用失败。",
    taskDeleteFailed: "删除事项失败。",
    taskSaveFailed: "保存事项失败。",
    taskDeleted: "事项已删除。",
    taskSaved: "事项已保存。",
    topicCreateFailed: "新建主题失败。",
    topicDeleteDefaultForbidden: "默认主题不能删除。",
    topicDeleteFailed: "删除主题失败。",
    topicDeleteNotEmpty: "这个主题下还有事项，不能删除。",
    topicDeleteNotFound: "这个主题已不存在。",
    topicListEmpty: "没有可用的主题。",
    topicUpdateFailed: "更新主题失败。",
    uploadTypeConflict: "上传目标中存在类型冲突的同名条目。",
    workspacePathUnavailable: "当前工作区路径不可用。"
  },
  priority: {
    high: "高",
    low: "低",
    medium: "中"
  },
  referencePicker: {
    browse: "浏览",
    confirm: "使用已选引用",
    emptyDirectory: "当前目录为空",
    emptySearch: "没有匹配的文件或文件夹",
    loading: "正在加载",
    previewBinary: "这个文件更像二进制内容",
    previewDecodeFailed: "暂时无法按 UTF-8 文本解码这个文件",
    previewError: "加载预览失败",
    previewFileTooLarge: "这个文件超过了 {{maxSize}}",
    previewFolder: "暂不支持预览文件夹",
    previewLoading: "正在加载预览",
    previewTextTooLarge: "这个文本文件超过了 {{maxSize}}",
    previewUnavailable: "当前工作区无法预览文件",
    previewUnsupported: "暂不支持预览这种文件类型",
    searchPlaceholder: "搜索文件和文件夹",
    selectedCount: "已选择 {{count}} 项",
    title: "选择工作区引用"
  },
  richTextAt: {
    loading: "正在加载...",
    noMatches: "没有匹配项"
  },
  run: {
    failedSummaryFallback: "运行失败",
    outputDirectory: "输出目录",
    requester: "发起人",
    status: "运行状态",
    summary: "摘要"
  },
  runPrompts: {
    breakdownIntro: "请基于这个 Issue 引用做任务拆解。",
    executeIntro: "请处理这个 Issue 引用。"
  },
  status: {
    canceled: "已取消",
    completed: "已完成",
    failed: "失败",
    inProgress: "已推进",
    notStarted: "待启动",
    pendingAcceptance: "待验收",
    running: "执行中",
    unknown: "未知"
  },
  title: "事项中心"
} as const satisfies I18nDictionary;

export type IssueManagerI18nKey = string;

export type IssueManagerI18nRuntime = I18nRuntime<IssueManagerI18nKey>;

const issueManagerDefaults: Record<IssueManagerI18nLocale, I18nDictionary> = {
  en: issueManagerEn,
  "zh-CN": issueManagerZhCN
};

export const issueManagerI18nResources = {
  en: {
    [issueManagerI18nNamespace]: issueManagerDefaults.en
  },
  "zh-CN": {
    [issueManagerI18nNamespace]: issueManagerDefaults["zh-CN"]
  }
} as const satisfies Record<IssueManagerI18nLocale, I18nDictionary>;

const defaultIssueManagerI18n = createI18nRuntime({
  dictionaries: [issueManagerI18nResources.en]
});

export function createIssueManagerI18nRuntime(
  runtime: I18nRuntime<string> | undefined
): IssueManagerI18nRuntime {
  return createScopedI18nRuntime<IssueManagerI18nKey>(
    runtime ?? defaultIssueManagerI18n,
    issueManagerI18nNamespace
  );
}
