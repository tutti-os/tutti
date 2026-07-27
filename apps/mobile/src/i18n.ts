import { NativeModules, Platform } from "react-native";

const messages = {
  en: {
    appName: "Tutti",
    agent: "Agent",
    allow: "Allow",
    answerHint: "Type your answer…",
    approval: "Approval",
    backToDevices: "Back to computers",
    backToWorkspaces: "Back to workspaces",
    cameraPermissionRequired:
      "Camera permission is required to scan the pairing QR code.",
    cancel: "Cancel",
    code: "Verification code",
    codeHint: "Enter the 6-digit code",
    connected: "Paired",
    connecting: "Connecting securely…",
    connectionFailed:
      "Could not reach this computer. Make sure Tutti is running and try again.",
    deviceEmpty:
      "Pair your computer to start using Agent sessions on your phone.",
    deviceEmptyTitle: "No computer paired",
    devices: "Your computers",
    deny: "Deny",
    emptyConversation: "Send a message to continue this Agent session.",
    emptySessions: "No Agent sessions in this workspace yet.",
    desktopFallback: "Tutti Desktop",
    email: "Email",
    emailHint: "you@example.com",
    emailSent: "We sent a verification code to your email.",
    genericError: "Something went wrong. Please try again.",
    githubLoginAction: "Continue with GitHub",
    loginAction: "Send verification code",
    loginAlternative: "or use email",
    loginSubtitle: "Sign in with the same Tutti account used on your computer.",
    loginTitle: "Continue on your phone",
    logout: "Sign out",
    messageHint: "Message Agent…",
    newSession: "New session",
    newSessionHint: "Choose an Agent, then send the first message.",
    noWorkspace: "No workspace is available on this computer.",
    pendingInteraction: "Pending interaction",
    pendingInteractionDesktop: "Open Tutti Desktop to answer this interaction.",
    plan: "Plan",
    question: "Question",
    pairAction: "Scan pairing code",
    pairingCodeAction: "Enter pairing code",
    pairingCodeHint: "Paste the pairing code shown by Tutti Desktop",
    pairingCodeSubmit: "Pair with code",
    pairing: "Pairing…",
    pairingConfirmed: "Computer paired. Preparing the secure connection…",
    pairingFailed:
      "This pairing code could not be used. Create a new code on your computer.",
    pairingWaiting: "Waiting for your computer to confirm…",
    retry: "Retry",
    running: "Running",
    ready: "Ready",
    reasoning: "Reasoning",
    send: "Send",
    sessions: "Sessions",
    stop: "Stop",
    submit: "Submit",
    tool: "Tool",
    untitledSession: "Untitled session",
    scannerUnavailable: "QR scanner is unavailable on this device.",
    verifyAction: "Verify and sign in",
    welcome: "Remote Agent",
    you: "You"
  },
  zh: {
    appName: "Tutti",
    agent: "Agent",
    allow: "允许",
    answerHint: "输入你的回答…",
    approval: "授权确认",
    backToDevices: "返回电脑列表",
    backToWorkspaces: "返回工作区列表",
    cameraPermissionRequired: "需要允许相机权限才能扫描配对二维码",
    cancel: "取消",
    code: "验证码",
    codeHint: "输入 6 位验证码",
    connected: "已配对",
    connecting: "正在建立安全连接…",
    connectionFailed: "无法连接这台电脑，请确认 Tutti 正在运行后重试",
    deviceEmpty: "先配对你的电脑，即可在手机上使用 Agent 会话",
    deviceEmptyTitle: "还没有配对电脑",
    devices: "你的电脑",
    deny: "拒绝",
    emptyConversation: "发送消息以继续这个 Agent 会话",
    emptySessions: "这个工作区还没有 Agent 会话",
    desktopFallback: "Tutti 电脑",
    email: "邮箱",
    emailHint: "you@example.com",
    emailSent: "验证码已发送到你的邮箱",
    genericError: "操作失败，请稍后重试",
    githubLoginAction: "使用 GitHub 登录",
    loginAction: "发送验证码",
    loginAlternative: "或使用邮箱",
    loginSubtitle: "请使用电脑端登录的同一个 Tutti 账号",
    loginTitle: "在手机上继续",
    logout: "退出登录",
    messageHint: "给 Agent 发消息…",
    newSession: "新建会话",
    newSessionHint: "选择 Agent，然后发送第一条消息",
    noWorkspace: "这台电脑上没有可用的工作区",
    pendingInteraction: "待处理交互",
    pendingInteractionDesktop: "请在 Tutti 电脑端处理这个交互",
    plan: "计划确认",
    question: "问题",
    pairAction: "扫描配对二维码",
    pairingCodeAction: "输入配对码",
    pairingCodeHint: "粘贴 Tutti 电脑端显示的配对码",
    pairingCodeSubmit: "使用配对码",
    pairing: "正在配对…",
    pairingConfirmed: "电脑已配对，正在准备安全连接…",
    pairingFailed: "无法使用此配对二维码，请在电脑上重新生成",
    pairingWaiting: "等待电脑确认…",
    retry: "重试",
    running: "运行中",
    ready: "就绪",
    reasoning: "思考",
    send: "发送",
    sessions: "会话",
    stop: "停止",
    submit: "提交",
    tool: "工具",
    untitledSession: "未命名会话",
    scannerUnavailable: "当前设备无法打开二维码扫描器",
    verifyAction: "验证并登录",
    welcome: "远程 Agent",
    you: "你"
  }
} as const;

type MessageKey = keyof (typeof messages)["en"];

function deviceLanguage(): keyof typeof messages {
  const locale =
    Platform.OS === "ios"
      ? NativeModules.SettingsManager?.settings?.AppleLocale
      : NativeModules.TuttiMobileSecurity?.localeIdentifier;
  return String(locale ?? "en")
    .toLowerCase()
    .startsWith("zh")
    ? "zh"
    : "en";
}

const language = deviceLanguage();

export function t(key: MessageKey): string {
  return messages[language][key];
}
