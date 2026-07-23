import { NativeModules, Platform } from "react-native";

const messages = {
  en: {
    appName: "Tutti",
    cancel: "Cancel",
    code: "Verification code",
    codeHint: "Enter the 6-digit code",
    connected: "Paired",
    deviceEmpty:
      "Pair your computer to start using Agent sessions on your phone.",
    deviceEmptyTitle: "No computer paired",
    devices: "Your computers",
    desktopFallback: "Tutti Desktop",
    email: "Email",
    emailHint: "you@example.com",
    emailSent: "We sent a verification code to your email.",
    genericError: "Something went wrong. Please try again.",
    loginAction: "Send verification code",
    loginSubtitle: "Sign in with the same Tutti account used on your computer.",
    loginTitle: "Continue on your phone",
    logout: "Sign out",
    pairAction: "Scan pairing code",
    pairing: "Pairing…",
    pairingConfirmed: "Computer paired. Preparing the secure connection…",
    pairingFailed:
      "This pairing code could not be used. Create a new code on your computer.",
    pairingWaiting: "Waiting for your computer to confirm…",
    retry: "Retry",
    scannerUnavailable: "QR scanner is unavailable on this device.",
    verifyAction: "Verify and sign in",
    welcome: "Remote Agent"
  },
  zh: {
    appName: "Tutti",
    cancel: "取消",
    code: "验证码",
    codeHint: "输入 6 位验证码",
    connected: "已配对",
    deviceEmpty: "先配对你的电脑，即可在手机上使用 Agent 会话",
    deviceEmptyTitle: "还没有配对电脑",
    devices: "你的电脑",
    desktopFallback: "Tutti 电脑",
    email: "邮箱",
    emailHint: "you@example.com",
    emailSent: "验证码已发送到你的邮箱",
    genericError: "操作失败，请稍后重试",
    loginAction: "发送验证码",
    loginSubtitle: "请使用电脑端登录的同一个 Tutti 账号",
    loginTitle: "在手机上继续",
    logout: "退出登录",
    pairAction: "扫描配对二维码",
    pairing: "正在配对…",
    pairingConfirmed: "电脑已配对，正在准备安全连接…",
    pairingFailed: "无法使用此配对二维码，请在电脑上重新生成",
    pairingWaiting: "等待电脑确认…",
    retry: "重试",
    scannerUnavailable: "当前设备无法打开二维码扫描器",
    verifyAction: "验证并登录",
    welcome: "远程 Agent"
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
