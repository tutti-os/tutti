import { createI18nRuntime, type I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { agentGuiI18nResources } from "@tutti-os/agent-gui/i18n";
import { browserNodeI18nResources } from "@tutti-os/browser-node/i18n";
import { appCenterI18nResources } from "@tutti-os/workspace-app-center/i18n";
import { connectorMarketI18nResources } from "@tutti-os/connector-renderer/i18n";
import { issueManagerI18nResources } from "@tutti-os/workspace-issue-manager/i18n";
import { workspaceFileManagerI18nResources } from "@tutti-os/workspace-file-manager/i18n";
import { workspaceUserProjectI18nResources } from "@tutti-os/workspace-user-project/i18n";
import { terminalNodeI18nResources } from "@tutti-os/workspace-terminal/i18n";
import {
  workbenchHostI18nResources,
  workbenchMissionControlI18nResources,
  workbenchWindowChromeI18nResources
} from "@tutti-os/workbench-surface/i18n";
import {
  type DesktopI18nKey,
  en,
  type DesktopLocale,
  type I18nParams,
  type TranslationDictionary,
  zhCN
} from "../../../shared/i18n/index.ts";
import { getActiveLocale } from "./runtime.ts";

export type AppI18nRuntime = I18nRuntime<string>;

const desktopAppI18nResources = {
  en,
  "zh-CN": zhCN
} as const satisfies Record<DesktopLocale, TranslationDictionary>;

const appI18nRuntimes = new Map<DesktopLocale, AppI18nRuntime>();

function createAppI18nRuntime(locale: DesktopLocale): AppI18nRuntime {
  return createI18nRuntime({
    dictionaries: [
      desktopAppI18nResources[locale],
      agentGuiI18nResources[locale],
      appCenterI18nResources[locale],
      connectorMarketI18nResources[locale],
      browserNodeI18nResources[locale],
      issueManagerI18nResources[locale],
      workspaceFileManagerI18nResources[locale],
      workspaceUserProjectI18nResources[locale],
      terminalNodeI18nResources[locale],
      workbenchHostI18nResources[locale],
      workbenchMissionControlI18nResources[locale],
      workbenchWindowChromeI18nResources[locale]
    ]
  });
}

export function getAppI18nRuntime(locale: DesktopLocale): AppI18nRuntime {
  const existing = appI18nRuntimes.get(locale);
  if (existing) {
    return existing;
  }

  const runtime = createAppI18nRuntime(locale);
  appI18nRuntimes.set(locale, runtime);
  return runtime;
}

export function translate(key: DesktopI18nKey, params?: I18nParams): string {
  return getAppI18nRuntime(getActiveLocale()).t(key, params);
}
