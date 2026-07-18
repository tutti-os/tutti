import type { DesktopLocale } from "@shared/i18n";
import type {
  DesktopAgentComposerDefaultsByAgentTarget,
  DesktopAgentComposerDefaultsByProvider,
  DesktopAgentGuiConversationRailCollapsedByProvider,
  DesktopAgentConversationDetailMode,
  DesktopDefaultAgentProvider,
  DesktopAppCatalogChannel,
  DesktopBrowserUseConnectionMode,
  DesktopDockIconStyle,
  DesktopDockPlacement,
  DeletedAgentConversationRetentionDays,
  DesktopFeatureFlags,
  DesktopFileDefaultOpenersByExtension,
  DesktopMinimizeAnimation,
  DesktopSleepPreventionMode,
  DesktopUpdateChannel,
  DesktopUpdatePolicy,
  DesktopWorkbenchShortcuts,
  DesktopWorkbenchWindowSnapping
} from "@shared/preferences";
import type { DesktopThemeState } from "@shared/theme";
import { proxy } from "valtio";
import type { DesktopPreferencesStoreState } from "../desktopPreferencesTypes.ts";

export function createDesktopPreferencesStore(input: {
  agentComposerDefaultsByProvider?: DesktopAgentComposerDefaultsByProvider;
  agentComposerDefaultsByAgentTarget?: DesktopAgentComposerDefaultsByAgentTarget;
  agentGuiConversationRailCollapsedByProvider?: DesktopAgentGuiConversationRailCollapsedByProvider;
  agentConversationDetailMode: DesktopAgentConversationDetailMode;
  appCatalogChannel: DesktopAppCatalogChannel;
  browserUseConnectionMode: DesktopBrowserUseConnectionMode;
  defaultAgentProvider: DesktopDefaultAgentProvider;
  dockIconStyle: DesktopDockIconStyle;
  dockPlacement: DesktopDockPlacement;
  deletedAgentConversationRetentionDays: DeletedAgentConversationRetentionDays;
  featureFlags: DesktopFeatureFlags;
  fileDefaultOpenersByExtension: DesktopFileDefaultOpenersByExtension;
  locale: DesktopLocale;
  minimizeAnimation: DesktopMinimizeAnimation;
  sleepPreventionMode: DesktopSleepPreventionMode;
  showAppDeveloperSources: boolean;
  theme: DesktopThemeState;
  updateChannel: DesktopUpdateChannel;
  updatePolicy: DesktopUpdatePolicy;
  workbenchShortcuts: DesktopWorkbenchShortcuts;
  workbenchWindowSnapping: DesktopWorkbenchWindowSnapping;
}): DesktopPreferencesStoreState {
  return proxy({
    changingDefaultAgentProvider: null,
    changingAgentConversationDetailMode: null,
    changingAppCatalogChannel: null,
    changingBrowserUseConnectionMode: null,
    changingDockIconStyle: null,
    changingDockPlacement: null,
    changingDeletedAgentConversationRetentionDays: null,
    changingLocale: null,
    changingFeatureFlags: null,
    changingMinimizeAnimation: null,
    changingSleepPreventionMode: null,
    changingShowAppDeveloperSources: null,
    changingThemeSource: null,
    changingUpdateChannel: null,
    changingUpdatePolicy: null,
    changingWorkbenchWindowSnapping: null,
    agentComposerDefaultsByProvider:
      input.agentComposerDefaultsByProvider ?? {},
    agentComposerDefaultsByAgentTarget:
      input.agentComposerDefaultsByAgentTarget ?? {},
    agentGuiConversationRailCollapsedByProvider:
      input.agentGuiConversationRailCollapsedByProvider ?? {},
    agentConversationDetailMode: input.agentConversationDetailMode,
    appCatalogChannel: input.appCatalogChannel,
    browserUseConnectionMode: input.browserUseConnectionMode,
    defaultAgentProvider: input.defaultAgentProvider,
    dockIconStyle: input.dockIconStyle,
    dockPlacement: input.dockPlacement,
    deletedAgentConversationRetentionDays:
      input.deletedAgentConversationRetentionDays,
    featureFlags: input.featureFlags,
    fileDefaultOpenersByExtension: input.fileDefaultOpenersByExtension,
    locale: input.locale,
    minimizeAnimation: input.minimizeAnimation,
    sleepPreventionMode: input.sleepPreventionMode,
    showAppDeveloperSources: input.showAppDeveloperSources,
    theme: input.theme,
    updateChannel: input.updateChannel,
    updatePolicy: input.updatePolicy,
    workbenchShortcuts: input.workbenchShortcuts,
    workbenchWindowSnapping: input.workbenchWindowSnapping
  });
}
