export const zhCNAgentGuiRuntimeNotices = {
  visibleErrorStartFailed: "{{provider}} 启动失败",
  visibleErrorRequestFailed: "{{provider}} 请求失败",
  visibleErrorAuthRequired: "{{provider}} 需要认证或配置",
  visibleErrorAuthRequiredLocalAgentHint:
    "请在本地登录 {{provider}}，然后重试。",
  visibleErrorRequestTimedOut: "{{provider}} 请求超时",
  visibleErrorRuntimeUnavailable: "{{provider}} 因运行环境不可用而无法启动",
  visibleErrorQuotaOrRateLimit: "{{provider}} 请求失败：额度或频率限制已触发",
  visibleErrorSubscriptionRequired:
    "{{provider}} 需要有效订阅，或当前套餐不支持此请求",
  visibleErrorModelNotAllowed: "{{provider}} 当前账号无法使用所选模型",
  visibleErrorPluginUnavailable: "{{provider}} 暂时无法使用可选集成",
  visibleErrorSessionInterrupted: "{{provider}} 在完成前意外停止，请重试",
  visibleErrorDetails: "查看详情",
  visibleErrorRawDetails: "原始错误",
  visibleErrorCliNotFound:
    "未检测到 {{provider}} CLI，无法运行。请先完成安装。",
  visibleErrorVersionUnsupported:
    "当前 {{provider}} 版本过旧，不支持此请求。请先升级。",
  visibleErrorNetwork: "{{provider}} 无法连接网络以完成此请求。",
  visibleErrorConfigTimeout:
    "{{provider}} 在请求超时前未能应用会话设置。请稍后重试。",
  visibleErrorStreamDisconnected:
    "{{provider}} 的响应在完成前被中断。请稍后重试。",
  visibleErrorEmptyResponse:
    "{{provider}} 没有返回响应，请检查提供商设置或重试",
  visibleErrorConcurrencyLimit:
    "{{provider}} 当前处理的请求过多。请在其他任务完成后再试。",
  visibleErrorInsufficientCreditsUnknown:
    "{{provider}} 的积分或账户余额不足，无法继续",
  visibleErrorActionInstall: "去连接",
  visibleErrorActionUpgrade: "去升级",
  visibleErrorActionRelogin: "登录",
  visibleErrorActionCheckNetwork: "检测网络",
  visibleErrorActionDetect: "打开检测",
  systemNoticeTransportRetry: "Agent 连接中断，正在重连",
  systemNoticeTransportFallback: "Agent 已切换到 HTTPS 传输",
  systemNoticePlanImplementationPendingConfirmation: "计划实现正在等待确认",
  systemNoticePlanImplementationCompleted: "计划实现已开始",
  systemNoticeWarning: "Agent 警告",
  systemNoticeDefault: "Agent 通知",
  contextCompactionInProgress: "正在压缩上下文",
  contextCompactionCompleted: "已压缩上下文",
  contextCompactionInterrupted: "上下文压缩已中断",
  contextHandoffRequired: "当前对话已达到上下文上限",
  contextHandoffRequiredDetail:
    "当前对话无法继续，请新建对话，并在新对话中 @当前对话 以交接上下文",
  sharedDeviceLabel: "共享设备",
  agentSharingRevoked: "{{owner}} 已取消共享该智能体",
  runtimeConnecting: "正在连接 {{device}}…",
  runtimeReconnectingAttempt:
    "正在重新连接 {{device}} · 第 {{attempt}} 次重试…",
  runtimeUnavailable: "与 {{device}} 的连接已断开，系统将自动重试",
  runtimeUnavailableActive:
    "与 {{device}} 的连接已断开，暂时无法发送或停止；任务可能仍在设备上运行",
  runtimeSynchronizingProgress: "正在同步最新任务进度…",
  interactionSynchronizing: "正在同步共享 Agent 状态，请稍后重试",
  interactionOwnerOffline: "共享 Agent 的 Owner 当前离线",
  interactionBindingRevoked: "共享 Agent 已失效，暂不可操作"
} as const;
