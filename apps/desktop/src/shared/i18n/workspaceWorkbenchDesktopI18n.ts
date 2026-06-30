import {
  createScopedI18nRuntime,
  type I18nDictionary,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";
import type { DesktopLocale } from "./core/locale.ts";
import { en } from "./locales/en.ts";
import { zhCN } from "./locales/zh-CN.ts";

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type StringKey<T> = Extract<keyof T, string>;

type NestedLeafPaths<T> = {
  [Key in StringKey<T>]: T[Key] extends Primitive
    ? Key
    : T[Key] extends readonly unknown[]
      ? Key
      : `${Key}.${NestedLeafPaths<T[Key]>}`;
}[StringKey<T>];

export const workspaceWorkbenchDesktopI18nNamespace =
  "workspace.workbenchDesktop";

const workspaceWorkbenchDesktopEn = en.workspace.workbenchDesktop;
const workspaceWorkbenchDesktopZhCN = zhCN.workspace.workbenchDesktop;

export type WorkspaceWorkbenchDesktopI18nKey = NestedLeafPaths<
  typeof workspaceWorkbenchDesktopEn
>;

export type WorkspaceWorkbenchDesktopI18nRuntime =
  I18nRuntime<WorkspaceWorkbenchDesktopI18nKey>;

export const workspaceWorkbenchDesktopI18nKeys = {
  closeGuard: {
    cancel: "closeGuard.cancel",
    confirm: "closeGuard.confirm",
    description: "closeGuard.description",
    title: "closeGuard.title"
  },
  windowCloseGuard: {
    cancel: "windowCloseGuard.cancel",
    confirm: "windowCloseGuard.confirm",
    description: "windowCloseGuard.description",
    title: "windowCloseGuard.title"
  },
  windowControls: {
    close: "windowControls.close",
    maximize: "windowControls.maximize",
    minimize: "windowControls.minimize",
    restore: "windowControls.restore"
  },
  nodes: {
    agent: "nodes.agent",
    browser: "nodes.browser",
    files: "nodes.files",
    imageFile: "nodes.imageFile",
    textFile: "nodes.textFile",
    terminal: "nodes.terminal"
  },
  filePreview: {
    loading: "filePreview.loading",
    revert: "filePreview.revert",
    save: "filePreview.save",
    saved: "filePreview.saved",
    saveFailed: "filePreview.saveFailed",
    saving: "filePreview.saving",
    unsaved: "filePreview.unsaved",
    unsupportedFallback: "filePreview.unsupportedFallback"
  },
  agentProviders: {
    checking: "agentProviders.checking",
    comingSoon: "agentProviders.comingSoon",
    install: "agentProviders.install",
    installFailed: "agentProviders.installFailed",
    installFailedDescription: "agentProviders.installFailedDescription",
    installFailedMissingRuntime: "agentProviders.installFailedMissingRuntime",
    installFailedTimedOut: "agentProviders.installFailedTimedOut",
    installUnavailableInRegion: "agentProviders.installUnavailableInRegion",
    installRequired: "agentProviders.installRequired",
    installing: "agentProviders.installing",
    login: "agentProviders.login",
    loginFailed: "agentProviders.loginFailed",
    loginRequired: "agentProviders.loginRequired",
    manageActionConnect: "agentProviders.manageActionConnect",
    manageActionLogin: "agentProviders.manageActionLogin",
    manageActionOpeningLogin: "agentProviders.manageActionOpeningLogin",
    manageActionUnavailableTooltip:
      "agentProviders.manageActionUnavailableTooltip",
    manageColumnAction: "agentProviders.manageColumnAction",
    manageColumnAgent: "agentProviders.manageColumnAgent",
    manageColumnConfig: "agentProviders.manageColumnConfig",
    manageColumnConnection: "agentProviders.manageColumnConnection",
    manageConfigDetected: "agentProviders.manageConfigDetected",
    manageConfigMissing: "agentProviders.manageConfigMissing",
    manageProviderClaudeCode: "agentProviders.manageProviderClaudeCode",
    manageProviderCodex: "agentProviders.manageProviderCodex",
    manageProviderGemini: "agentProviders.manageProviderGemini",
    manageProviderHermes: "agentProviders.manageProviderHermes",
    manageProviderOpenClaw: "agentProviders.manageProviderOpenClaw",
    manageProviderTutti: "agentProviders.manageProviderTutti",
    manageStatusAuthRequired: "agentProviders.manageStatusAuthRequired",
    manageStatusAvailable: "agentProviders.manageStatusAvailable",
    manageStatusChecking: "agentProviders.manageStatusChecking",
    manageStatusConnected: "agentProviders.manageStatusConnected",
    manageStatusUnknown: "agentProviders.manageStatusUnknown",
    manageStatusUnsupported: "agentProviders.manageStatusUnsupported",
    manageTitle: "agentProviders.manageTitle",
    manageUnsupportedTooltip: "agentProviders.manageUnsupportedTooltip",
    refresh: "agentProviders.refresh",
    unknown: "agentProviders.unknown"
  },
  launchpad: {
    agentUnavailable: "launchpad.agentUnavailable",
    appUnavailable: "launchpad.appUnavailable",
    clearSearch: "launchpad.clearSearch",
    close: "launchpad.close",
    dockLabel: "launchpad.dockLabel",
    empty: "launchpad.empty",
    pageDot: "launchpad.pageDot",
    pages: "launchpad.pages",
    searchPlaceholder: "launchpad.searchPlaceholder",
    unavailableItem: "launchpad.unavailableItem"
  },
  missionControl: {
    activateShortcutDefault: "missionControl.activateShortcutDefault",
    activateShortcutMac: "missionControl.activateShortcutMac",
    activateTrigger: "missionControl.activateTrigger",
    layoutShortcutDefault: "missionControl.layoutShortcutDefault",
    layoutShortcutMac: "missionControl.layoutShortcutMac",
    layoutTrigger: "missionControl.layoutTrigger",
    unavailableTrigger: "missionControl.unavailableTrigger"
  }
} as const satisfies Record<string, unknown>;

export const workspaceWorkbenchDesktopI18nResources: Record<
  DesktopLocale,
  I18nDictionary
> = {
  en: {
    workspace: {
      workbenchDesktop: workspaceWorkbenchDesktopEn
    }
  },
  "zh-CN": {
    workspace: {
      workbenchDesktop: workspaceWorkbenchDesktopZhCN
    }
  }
};

export function createWorkspaceWorkbenchDesktopI18nRuntime(
  runtime: I18nRuntime<string>
): WorkspaceWorkbenchDesktopI18nRuntime {
  return createScopedI18nRuntime<WorkspaceWorkbenchDesktopI18nKey>(
    runtime,
    workspaceWorkbenchDesktopI18nNamespace
  );
}
