import type { DesktopLocale } from "@shared/i18n";
import type {
  DesktopAgentComposerDefaultsByProvider,
  DesktopAgentGuiConversationRailCollapsedByProvider,
  DesktopAgentConversationDetailMode,
  DesktopAgentDockLayout,
  DesktopAgentProvider,
  DesktopAppCatalogChannel,
  DesktopBrowserUseConnectionMode,
  DesktopDockIconStyle,
  DesktopDockPlacement,
  DesktopFileDefaultOpenersByExtension,
  DesktopMinimizeAnimation,
  DesktopSleepPreventionMode,
  DesktopUpdateChannel,
  DesktopUpdatePolicy,
  DesktopWorkbenchWindowSnapping
} from "@shared/preferences";
import type { DesktopThemeState } from "@shared/theme";
import { proxy } from "valtio";
import type { DesktopPreferencesStoreState } from "../desktopPreferencesTypes.ts";

export function createDesktopPreferencesStore(input: {
  agentComposerDefaultsByProvider?: DesktopAgentComposerDefaultsByProvider;
  agentGuiConversationRailCollapsedByProvider?: DesktopAgentGuiConversationRailCollapsedByProvider;
  agentConversationDetailMode: DesktopAgentConversationDetailMode;
  agentDockLayout: DesktopAgentDockLayout;
  appCatalogChannel: DesktopAppCatalogChannel;
  browserUseConnectionMode: DesktopBrowserUseConnectionMode;
  defaultAgentProvider: DesktopAgentProvider;
  dockIconStyle: DesktopDockIconStyle;
  dockPlacement: DesktopDockPlacement;
  fileDefaultOpenersByExtension: DesktopFileDefaultOpenersByExtension;
  locale: DesktopLocale;
  minimizeAnimation: DesktopMinimizeAnimation;
  sleepPreventionMode: DesktopSleepPreventionMode;
  showAppDeveloperSources: boolean;
  theme: DesktopThemeState;
  updateChannel: DesktopUpdateChannel;
  updatePolicy: DesktopUpdatePolicy;
  workbenchWindowSnapping: DesktopWorkbenchWindowSnapping;
}): DesktopPreferencesStoreState {
  return proxy({
    changingDefaultAgentProvider: null,
    changingAgentConversationDetailMode: null,
    changingAgentDockLayout: null,
    changingAppCatalogChannel: null,
    changingBrowserUseConnectionMode: null,
    changingDockIconStyle: null,
    changingDockPlacement: null,
    changingLocale: null,
    changingMinimizeAnimation: null,
    changingSleepPreventionMode: null,
    changingShowAppDeveloperSources: null,
    changingThemeSource: null,
    changingUpdateChannel: null,
    changingUpdatePolicy: null,
    changingWorkbenchWindowSnapping: null,
    agentComposerDefaultsByProvider:
      input.agentComposerDefaultsByProvider ?? {},
    agentGuiConversationRailCollapsedByProvider:
      input.agentGuiConversationRailCollapsedByProvider ?? {},
    agentConversationDetailMode: input.agentConversationDetailMode,
    agentDockLayout: input.agentDockLayout,
    appCatalogChannel: input.appCatalogChannel,
    browserUseConnectionMode: input.browserUseConnectionMode,
    defaultAgentProvider: input.defaultAgentProvider,
    dockIconStyle: input.dockIconStyle,
    dockPlacement: input.dockPlacement,
    fileDefaultOpenersByExtension: input.fileDefaultOpenersByExtension,
    locale: input.locale,
    minimizeAnimation: input.minimizeAnimation,
    sleepPreventionMode: input.sleepPreventionMode,
    showAppDeveloperSources: input.showAppDeveloperSources,
    theme: input.theme,
    updateChannel: input.updateChannel,
    updatePolicy: input.updatePolicy,
    workbenchWindowSnapping: input.workbenchWindowSnapping
  });
}
