import {
  createScopedLocaleObjectsI18nModuleManifest,
  createI18nRuntime,
  createScopedI18nRuntime,
  type I18nDictionary,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";

type WorkbenchMissionControlI18nLocale = "en" | "zh-CN";

export const workbenchMissionControlI18nNamespace = "workbenchMissionControl";

export const tuttiI18nModule = createScopedLocaleObjectsI18nModuleManifest({
  localeObjectByLocale: {
    en: "workbenchMissionControlEn",
    "zh-CN": "workbenchMissionControlZhCN"
  },
  name: "workbench-mission-control",
  namespace: "workbenchMissionControl",
  sourceRoot: "packages/workbench/surface/src"
});

const workbenchMissionControlEn = {
  layoutSelectionHint: "Select multiple windows to arrange",
  noAvailableLayout: "No layout fits the selected windows",
  presets: {
    balanced: "Balanced layout",
    column: "Vertical equal layout",
    row: "Horizontal equal layout"
  }
} as const satisfies I18nDictionary;

const workbenchMissionControlZhCN = {
  layoutSelectionHint: "请选择多个你要整理布局的窗口",
  noAvailableLayout: "当前没有可用布局",
  presets: {
    balanced: "智能均衡布局",
    column: "垂直等分布局",
    row: "水平等分布局"
  }
} as const satisfies I18nDictionary;

export type WorkbenchMissionControlI18nKey =
  | "layoutSelectionHint"
  | "noAvailableLayout"
  | "presets.balanced"
  | "presets.column"
  | "presets.row";

export type WorkbenchMissionControlI18nRuntime =
  I18nRuntime<WorkbenchMissionControlI18nKey>;

const workbenchMissionControlDefaults: Record<
  WorkbenchMissionControlI18nLocale,
  I18nDictionary
> = {
  en: workbenchMissionControlEn,
  "zh-CN": workbenchMissionControlZhCN
};

export const workbenchMissionControlI18nResources: Record<
  WorkbenchMissionControlI18nLocale,
  I18nDictionary
> = {
  en: {
    [workbenchMissionControlI18nNamespace]: workbenchMissionControlDefaults.en
  },
  "zh-CN": {
    [workbenchMissionControlI18nNamespace]:
      workbenchMissionControlDefaults["zh-CN"]
  }
};

const defaultWorkbenchMissionControlI18n = createI18nRuntime({
  dictionaries: [workbenchMissionControlI18nResources.en]
});

export function createWorkbenchMissionControlI18nRuntime(
  runtime: I18nRuntime<string> | undefined
): WorkbenchMissionControlI18nRuntime {
  return createScopedI18nRuntime<WorkbenchMissionControlI18nKey>(
    runtime ?? defaultWorkbenchMissionControlI18n,
    workbenchMissionControlI18nNamespace
  );
}
