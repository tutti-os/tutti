export const zhCNMessages = {
  agentLaunchFailed: "Agent 启动失败：{{message}}",
  agentResumeFailed: "Agent 继续失败：{{message}}",
  agentProviderSessionNotFound:
    "这条会话历史仍可查看，但底层 Provider 会话已经无法恢复。",
  agentResumeSessionNotLocal:
    "这个会话没法在当前设备里直接恢复，你可以在新会话里 @这段对话，接着继续聊。",
  agentSettingsRequireNewSession: "为了保留上下文，这个模型只能在新会话中使用",
  agentPermissionModeAppliesNextTurn: "权限模式将从你的下一条消息开始生效。",
  agentThisSessionMentionLabel: "本 session",
  terminalLaunchFailed: "终端启动失败：{{message}}",
  fallbackTerminalFailed: "兜底终端启动也失败了：{{message}}",
  agentPromptRequired: "Agent 提示词不能为空。",
  resumeSessionMissing: "该 Agent 还没有已验证的 resumeSessionId。",
  noTerminalSlotNearby:
    "当前视图附近没有可用空位，请先移动或关闭部分终端窗口。",
  noWindowSlotOnRight: "当前 Agent 右侧没有可用空位，请先移动或关闭部分窗口。",
  noWindowSlotNearby: "当前视图附近没有可用空位，请先移动或关闭部分窗口。",
  agentManageSyncSuccess: "同步成功",
  agentManageInstallSuccess: "安装成功"
} as const;
