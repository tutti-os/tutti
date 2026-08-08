import {
  createI18nRuntime,
  type I18nDictionary,
  type I18nParams,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";
import { workspaceUserProjectI18nResources } from "@tutti-os/workspace-user-project/i18n";
import { en } from "../app/renderer/i18n/locales/en.ts";
import { zhCN } from "../app/renderer/i18n/locales/zh-CN.ts";

export type AgentGuiI18nLocale = "en" | "zh-CN";
export type TranslateOptions = I18nParams;
export type TranslateFn = (key: string, options?: TranslateOptions) => string;

export const agentGuiI18nResources = {
  en,
  "zh-CN": zhCN
} as const satisfies Record<AgentGuiI18nLocale, I18nDictionary>;

const defaultAgentGuiI18nRuntime = createBundledAgentGuiI18nRuntime("en");

const runtimeByLocale = new Map<AgentGuiI18nLocale, I18nRuntime<string>>();

function runtimeForLocale(locale: AgentGuiI18nLocale): I18nRuntime<string> {
  const existing = runtimeByLocale.get(locale);
  if (existing) {
    return existing;
  }
  const runtime = createBundledAgentGuiI18nRuntime(locale);
  runtimeByLocale.set(locale, runtime);
  return runtime;
}

function createBundledAgentGuiI18nRuntime(
  locale: AgentGuiI18nLocale
): I18nRuntime<string> {
  return createI18nRuntime({
    dictionaries: [
      agentGuiI18nResources[locale],
      workspaceUserProjectI18nResources[locale]
    ]
  });
}

// Bridge existing non-React translation helpers until their call sites receive an explicit t.
let currentRuntime: I18nRuntime<string> = defaultAgentGuiI18nRuntime;
let currentLocale: AgentGuiI18nLocale = "en";

export function resolveAgentGuiI18nRuntime({
  locale,
  runtime
}: {
  locale: AgentGuiI18nLocale;
  runtime?: I18nRuntime<string> | null;
}): {
  locale: AgentGuiI18nLocale;
  runtime: I18nRuntime<string>;
} {
  return {
    locale,
    runtime: runtime ?? runtimeForLocale(locale)
  };
}

export function setCurrentAgentGuiI18nRuntime(value: {
  locale: AgentGuiI18nLocale;
  runtime: I18nRuntime<string>;
}): void {
  currentLocale = value.locale;
  currentRuntime = value.runtime;
}

export function getCurrentAgentGuiI18nRuntime(): {
  locale: AgentGuiI18nLocale;
  runtime: I18nRuntime<string>;
} {
  return {
    locale: currentLocale,
    runtime: currentRuntime
  };
}

export function translate(key: string, options?: TranslateOptions): string {
  return currentRuntime.t(key, options);
}

export function translateInUiLanguage(
  locale: AgentGuiI18nLocale,
  key: string,
  options?: TranslateOptions
): string {
  return runtimeForLocale(locale).t(key, options);
}

export function getActiveUiLanguage(): AgentGuiI18nLocale {
  return currentLocale;
}

export function setCurrentAgentGuiI18nLocaleForTests(
  locale: AgentGuiI18nLocale
): void {
  const runtime = runtimeForLocale(locale);
  setCurrentAgentGuiI18nRuntime({ locale, runtime });
}
