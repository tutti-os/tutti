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
    installUnavailableInRegion: "agentProviders.installUnavailableInRegion",
    installRequired: "agentProviders.installRequired",
    installing: "agentProviders.installing",
    login: "agentProviders.login",
    loginFailed: "agentProviders.loginFailed",
    loginRequired: "agentProviders.loginRequired",
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
