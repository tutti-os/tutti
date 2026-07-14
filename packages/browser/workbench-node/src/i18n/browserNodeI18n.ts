import {
  createI18nRuntime,
  createScopedI18nRuntime,
  createScopedLocaleObjectsI18nModuleManifest,
  type I18nDictionary,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";

type BrowserNodeI18nLocale = "en" | "zh-CN";
export const browserNodeI18nNamespace = "browserNode";
export const browserNodeI18nModule =
  createScopedLocaleObjectsI18nModuleManifest({
    localeObjectByLocale: {
      en: "browserNodeEn",
      "zh-CN": "browserNodeZhCN"
    },
    name: "browser-node",
    namespace: "browserNode",
    sourceRoot: "packages/browser/workbench-node/src"
  });

const browserNodeEn = {
  actions: {
    back: "Back",
    cancelDownload: "Cancel download",
    clearBrowsingData: "Clear browsing data",
    browserSettings: "Browser settings",
    deviceEmulation: "Device emulation",
    downloads: "Downloads",
    findInPage: "Find in page",
    forward: "Forward",
    more: "More browser actions",
    openDevTools: "Open DevTools",
    openDownload: "Open file",
    openExternal: "Open in external browser",
    pauseDownload: "Pause download",
    print: "Print",
    reload: "Reload",
    resumeDownload: "Resume download",
    saveScreenshot: "Capture screenshot",
    screenshotMode: "Screenshot mode",
    showDownloadInFolder: "Show in folder"
  },
  device: {
    desktop: "Desktop",
    ipadAir: "iPad Air",
    iphone14: "iPhone 14",
    pixel7: "Pixel 7"
  },
  addressLabel: "Address",
  addressPlaceholder: "Search or enter address",
  coldStatus: "Sleeping",
  clearBrowsingData: {
    cancel: "Cancel",
    confirm: "Clear data",
    description:
      "Cookies, cache, and site storage for this browser profile will be removed. Other profiles are not affected.",
    title: "Clear browsing data?"
  },
  dockLabel: "Browser",
  downloads: {
    empty: "No downloads yet",
    status: {
      cancelled: "Cancelled",
      completed: "Completed",
      interrupted: "Interrupted",
      paused: "Paused",
      progressing: "Downloading"
    }
  },
  errors: {
    invalidUrl: "Enter a valid web address.",
    navigationFailed: "The page could not be loaded.",
    navigationFailedWithStatus:
      "The page could not be loaded. HTTP {{statusCode}}.",
    errorCode: "Error {{errorCode}}",
    statusCode: "HTTP {{statusCode}}",
    unsupportedProtocol: "This address type is not supported.",
    unsupportedUrl: "This page cannot be opened."
  },
  loadFailed: "Page load failed",
  find: {
    close: "Close find",
    next: "Next match",
    placeholder: "Find in page",
    previous: "Previous match",
    results: "{{current}} of {{total}}"
  },
  screenshot: {
    fullPage: "Full page",
    visible: "Visible area"
  },
  settings: {
    chooseDirectory: "Choose folder",
    close: "Done",
    cookiesDescription:
      "Import a JSON or Netscape Cookie file into this browser profile.",
    cookiesLabel: "Cookies",
    dataDescription:
      "Remove Cookies, cache, and site storage from this profile.",
    dataLabel: "Browsing data",
    description: "Settings apply to the current browser session.",
    deviceLabel: "Emulated device",
    downloadDirectory: "System Downloads folder",
    downloadLabel: "Download location",
    importCookies: "Import Cookie file",
    importFailed: "Cookie import failed.",
    importResult: "Imported {{imported}}; skipped {{skipped}}.",
    importingCookies: "Importing…",
    screenshotLabel: "Default screenshot",
    title: "Browser settings",
    zoomLabel: "Page zoom"
  },
  tabs: {
    close: "Close tab",
    new: "New tab",
    untitled: "New tab"
  },
  zoom: {
    decrease: "Zoom out",
    increase: "Zoom in",
    label: "Zoom",
    reset: "Reset zoom"
  },
  title: "Browser"
} as const satisfies I18nDictionary;

const browserNodeZhCN = {
  actions: {
    back: "后退",
    cancelDownload: "取消下载",
    clearBrowsingData: "清除浏览数据",
    browserSettings: "浏览器设置",
    deviceEmulation: "设备模拟",
    downloads: "下载",
    findInPage: "在页面中查找",
    forward: "前进",
    more: "更多浏览器操作",
    openDevTools: "打开开发者工具",
    openDownload: "打开文件",
    openExternal: "使用外部浏览器打开",
    pauseDownload: "暂停下载",
    print: "打印",
    reload: "重新加载",
    resumeDownload: "继续下载",
    saveScreenshot: "截取屏幕截图",
    screenshotMode: "截图方式",
    showDownloadInFolder: "在文件夹中显示"
  },
  device: {
    desktop: "桌面设备",
    ipadAir: "iPad Air",
    iphone14: "iPhone 14",
    pixel7: "Pixel 7"
  },
  addressLabel: "地址",
  addressPlaceholder: "搜索或输入地址",
  coldStatus: "休眠中",
  clearBrowsingData: {
    cancel: "取消",
    confirm: "清除数据",
    description:
      "将清除此浏览器资料中的 Cookie、缓存和网站存储，不会影响其他资料。",
    title: "清除浏览数据？"
  },
  dockLabel: "浏览器",
  downloads: {
    empty: "暂无下载",
    status: {
      cancelled: "已取消",
      completed: "已完成",
      interrupted: "已中断",
      paused: "已暂停",
      progressing: "下载中"
    }
  },
  errors: {
    invalidUrl: "请输入有效的网址。",
    navigationFailed: "页面无法加载。",
    navigationFailedWithStatus: "页面无法加载。HTTP {{statusCode}}。",
    errorCode: "错误 {{errorCode}}",
    statusCode: "HTTP {{statusCode}}",
    unsupportedProtocol: "不支持此地址类型。",
    unsupportedUrl: "无法打开此页面。"
  },
  loadFailed: "页面加载失败",
  find: {
    close: "关闭查找",
    next: "下一个匹配项",
    placeholder: "在页面中查找",
    previous: "上一个匹配项",
    results: "第 {{current}} 项，共 {{total}} 项"
  },
  screenshot: {
    fullPage: "完整页面",
    visible: "可见区域"
  },
  settings: {
    chooseDirectory: "选择文件夹",
    close: "完成",
    cookiesDescription: "将 JSON 或 Netscape Cookie 文件导入当前浏览器资料。",
    cookiesLabel: "Cookie",
    dataDescription: "清除此浏览器资料中的 Cookie、缓存和网站存储。",
    dataLabel: "浏览数据",
    description: "这些设置应用于当前浏览器会话。",
    deviceLabel: "模拟设备",
    downloadDirectory: "系统下载文件夹",
    downloadLabel: "下载位置",
    importCookies: "导入 Cookie 文件",
    importFailed: "Cookie 导入失败。",
    importResult: "已导入 {{imported}} 项，跳过 {{skipped}} 项。",
    importingCookies: "正在导入…",
    screenshotLabel: "默认截图方式",
    title: "浏览器设置",
    zoomLabel: "页面缩放"
  },
  tabs: {
    close: "关闭标签页",
    new: "新建标签页",
    untitled: "新标签页"
  },
  zoom: {
    decrease: "缩小",
    increase: "放大",
    label: "缩放",
    reset: "重置缩放"
  },
  title: "浏览器"
} as const satisfies I18nDictionary;

export type BrowserNodeI18nKey =
  | "actions.back"
  | "actions.cancelDownload"
  | "actions.clearBrowsingData"
  | "actions.browserSettings"
  | "actions.deviceEmulation"
  | "actions.downloads"
  | "actions.findInPage"
  | "actions.forward"
  | "actions.more"
  | "actions.openDevTools"
  | "actions.openDownload"
  | "actions.openExternal"
  | "actions.pauseDownload"
  | "actions.print"
  | "actions.reload"
  | "actions.resumeDownload"
  | "actions.saveScreenshot"
  | "actions.screenshotMode"
  | "actions.showDownloadInFolder"
  | "addressLabel"
  | "addressPlaceholder"
  | "coldStatus"
  | "device.desktop"
  | "device.ipadAir"
  | "device.iphone14"
  | "device.pixel7"
  | "clearBrowsingData.cancel"
  | "clearBrowsingData.confirm"
  | "clearBrowsingData.description"
  | "clearBrowsingData.title"
  | "dockLabel"
  | "downloads.empty"
  | "downloads.status.cancelled"
  | "downloads.status.completed"
  | "downloads.status.interrupted"
  | "downloads.status.paused"
  | "downloads.status.progressing"
  | "errors.invalidUrl"
  | "errors.errorCode"
  | "errors.navigationFailed"
  | "errors.navigationFailedWithStatus"
  | "errors.statusCode"
  | "errors.unsupportedProtocol"
  | "errors.unsupportedUrl"
  | "loadFailed"
  | "find.close"
  | "find.next"
  | "find.placeholder"
  | "find.previous"
  | "find.results"
  | "screenshot.fullPage"
  | "screenshot.visible"
  | "settings.chooseDirectory"
  | "settings.close"
  | "settings.cookiesDescription"
  | "settings.cookiesLabel"
  | "settings.dataDescription"
  | "settings.dataLabel"
  | "settings.description"
  | "settings.deviceLabel"
  | "settings.downloadDirectory"
  | "settings.downloadLabel"
  | "settings.importCookies"
  | "settings.importFailed"
  | "settings.importResult"
  | "settings.importingCookies"
  | "settings.screenshotLabel"
  | "settings.title"
  | "settings.zoomLabel"
  | "tabs.close"
  | "tabs.new"
  | "tabs.untitled"
  | "zoom.decrease"
  | "zoom.increase"
  | "zoom.label"
  | "zoom.reset"
  | "title";

export type BrowserNodeI18nRuntime = I18nRuntime<BrowserNodeI18nKey>;

const browserNodeDefaults: Record<BrowserNodeI18nLocale, I18nDictionary> = {
  en: browserNodeEn,
  "zh-CN": browserNodeZhCN
};

export const browserNodeI18nResources = {
  en: {
    [browserNodeI18nNamespace]: browserNodeDefaults.en
  },
  "zh-CN": {
    [browserNodeI18nNamespace]: browserNodeDefaults["zh-CN"]
  }
} as const satisfies Record<BrowserNodeI18nLocale, I18nDictionary>;

const defaultBrowserNodeI18n = createI18nRuntime({
  dictionaries: [browserNodeI18nResources.en]
});

export function createBrowserNodeI18nRuntime(
  runtime: I18nRuntime<string> | undefined
): BrowserNodeI18nRuntime {
  return createScopedI18nRuntime<BrowserNodeI18nKey>(
    runtime ?? defaultBrowserNodeI18n,
    browserNodeI18nNamespace
  );
}
