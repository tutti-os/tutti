import {
  createScopedLocaleObjectsI18nModuleManifest,
  createI18nRuntime,
  createScopedI18nRuntime,
  type I18nDictionary,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";

type WorkbenchHostI18nLocale = "en" | "zh-CN";
export const workbenchHostI18nNamespace = "workbenchHost";
export const tuttiI18nModule = createScopedLocaleObjectsI18nModuleManifest({
  localeObjectByLocale: {
    en: "workbenchHostEn",
    "zh-CN": "workbenchHostZhCN"
  },
  name: "workbench-host",
  namespace: "workbenchHost",
  sourceRoot: "packages/workbench/surface/src"
});

const workbenchHostEn = {
  actions: {
    close: "Close workbench window",
    minimize: "Minimize workbench window"
  },
  closeWindow: "Close {{title}}",
  dockContextMenu: {
    fullscreen: "Full Screen",
    hide: "Minimize",
    keepInDock: "Keep in Dock",
    open: "Open",
    quit: "Quit",
    removeFromDock: "Remove from Dock",
    showAllWindows: "Show All Similar Windows"
  },
  dockLabel: "Workbench dock",
  launch: "Open {{title}}",
  minimizedWindows: "Minimized windows",
  newWindow: "New window",
  scrollDockDown: "Scroll dock down",
  scrollDockLeft: "Scroll dock left",
  scrollDockRight: "Scroll dock right",
  scrollDockUp: "Scroll dock up",
  windowStatus: {
    active: "Active",
    minimized: "Minimized",
    open: "Open"
  }
} as const satisfies I18nDictionary;

const workbenchHostZhCN = {
  actions: {
    close: "关闭工作台窗口",
    minimize: "最小化工作台窗口"
  },
  closeWindow: "关闭 {{title}}",
  dockContextMenu: {
    fullscreen: "全屏",
    hide: "最小化",
    keepInDock: "在程序坞中保留",
    open: "打开",
    quit: "退出",
    removeFromDock: "从程序坞中移除",
    showAllWindows: "显示所有同类窗口"
  },
  dockLabel: "工作台程序坞",
  launch: "打开 {{title}}",
  minimizedWindows: "已最小化窗口",
  newWindow: "新建窗口",
  scrollDockDown: "向下滚动程序坞",
  scrollDockLeft: "向左滚动程序坞",
  scrollDockRight: "向右滚动程序坞",
  scrollDockUp: "向上滚动程序坞",
  windowStatus: {
    active: "当前窗口",
    minimized: "已最小化",
    open: "已打开"
  }
} as const satisfies I18nDictionary;

export type WorkbenchHostI18nKey =
  | "actions.close"
  | "actions.minimize"
  | "closeWindow"
  | "dockContextMenu.fullscreen"
  | "dockContextMenu.hide"
  | "dockContextMenu.keepInDock"
  | "dockContextMenu.open"
  | "dockContextMenu.quit"
  | "dockContextMenu.removeFromDock"
  | "dockContextMenu.showAllWindows"
  | "dockLabel"
  | "launch"
  | "minimizedWindows"
  | "newWindow"
  | "scrollDockDown"
  | "scrollDockLeft"
  | "scrollDockRight"
  | "scrollDockUp"
  | "windowStatus.active"
  | "windowStatus.minimized"
  | "windowStatus.open";

export type WorkbenchHostI18nRuntime = I18nRuntime<WorkbenchHostI18nKey>;

const workbenchHostDefaults: Record<WorkbenchHostI18nLocale, I18nDictionary> = {
  en: workbenchHostEn,
  "zh-CN": workbenchHostZhCN
};

export const workbenchHostI18nResources = {
  en: {
    [workbenchHostI18nNamespace]: workbenchHostDefaults.en
  },
  "zh-CN": {
    [workbenchHostI18nNamespace]: workbenchHostDefaults["zh-CN"]
  }
} as const satisfies Record<WorkbenchHostI18nLocale, I18nDictionary>;

const defaultWorkbenchHostI18n = createI18nRuntime({
  dictionaries: [workbenchHostI18nResources.en]
});

export function createWorkbenchHostI18nRuntime(
  runtime: I18nRuntime<string> | undefined
): WorkbenchHostI18nRuntime {
  return createScopedI18nRuntime<WorkbenchHostI18nKey>(
    runtime ?? defaultWorkbenchHostI18n,
    workbenchHostI18nNamespace
  );
}
