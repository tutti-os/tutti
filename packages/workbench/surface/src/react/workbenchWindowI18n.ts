import {
  createScopedLocaleObjectsI18nModuleManifest,
  createI18nRuntime,
  createScopedI18nRuntime,
  type I18nDictionary,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";

type WorkbenchWindowChromeI18nLocale = "en" | "zh-CN";
export const workbenchWindowChromeI18nNamespace = "workbenchWindowChrome";
export const tuttiI18nModule = createScopedLocaleObjectsI18nModuleManifest({
  localeObjectByLocale: {
    en: "workbenchWindowChromeEn",
    "zh-CN": "workbenchWindowChromeZhCN"
  },
  name: "workbench-window-chrome",
  namespace: "workbenchWindowChrome",
  sourceRoot: "packages/workbench/surface/src"
});

const workbenchWindowChromeEn = {
  enterFullscreen: "Full Screen",
  exitFullscreen: "Exit Full Screen",
  minimizeWindow: "Minimize to Dock",
  restoreWindow: "Restore Window"
} as const satisfies I18nDictionary;

const workbenchWindowChromeZhCN = {
  enterFullscreen: "全屏",
  exitFullscreen: "取消全屏",
  minimizeWindow: "最小化到 Dock",
  restoreWindow: "恢复窗口"
} as const satisfies I18nDictionary;

export type WorkbenchWindowChromeI18nKey = keyof typeof workbenchWindowChromeEn;

export type WorkbenchWindowChromeI18nRuntime =
  I18nRuntime<WorkbenchWindowChromeI18nKey>;

const workbenchWindowChromeDefaults: Record<
  WorkbenchWindowChromeI18nLocale,
  I18nDictionary
> = {
  en: workbenchWindowChromeEn,
  "zh-CN": workbenchWindowChromeZhCN
};

export const workbenchWindowChromeI18nResources: Record<
  WorkbenchWindowChromeI18nLocale,
  I18nDictionary
> = {
  en: {
    [workbenchWindowChromeI18nNamespace]: workbenchWindowChromeDefaults.en
  },
  "zh-CN": {
    [workbenchWindowChromeI18nNamespace]: workbenchWindowChromeDefaults["zh-CN"]
  }
};

const defaultWorkbenchWindowChromeI18n = createI18nRuntime({
  dictionaries: [workbenchWindowChromeI18nResources.en]
});

export function createWorkbenchWindowChromeI18nRuntime(
  runtime: I18nRuntime<string> | undefined
): WorkbenchWindowChromeI18nRuntime {
  return createScopedI18nRuntime<WorkbenchWindowChromeI18nKey>(
    runtime ?? defaultWorkbenchWindowChromeI18n,
    workbenchWindowChromeI18nNamespace
  );
}
