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
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";

export interface DesktopPreferencesStoreState {
  changingDefaultAgentProvider: DesktopAgentProvider | null;
  changingAgentConversationDetailMode: DesktopAgentConversationDetailMode | null;
  changingAgentDockLayout: DesktopAgentDockLayout | null;
  changingAppCatalogChannel: DesktopAppCatalogChannel | null;
  changingBrowserUseConnectionMode: DesktopBrowserUseConnectionMode | null;
  changingDockIconStyle: DesktopDockIconStyle | null;
  changingDockPlacement: DesktopDockPlacement | null;
  changingLocale: DesktopLocale | null;
  changingMinimizeAnimation: DesktopMinimizeAnimation | null;
  changingSleepPreventionMode: DesktopSleepPreventionMode | null;
  changingShowAppDeveloperSources: boolean | null;
  changingThemeSource: DesktopThemeSource | null;
  changingUpdateChannel: DesktopUpdateChannel | null;
  changingUpdatePolicy: DesktopUpdatePolicy | null;
  changingWorkbenchWindowSnapping: DesktopWorkbenchWindowSnapping | null;
  agentComposerDefaultsByProvider: DesktopAgentComposerDefaultsByProvider;
  agentGuiConversationRailCollapsedByProvider: DesktopAgentGuiConversationRailCollapsedByProvider;
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
}

export interface DesktopPreferencesReadableStoreState {
  readonly changingDefaultAgentProvider: DesktopAgentProvider | null;
  readonly changingAgentConversationDetailMode: DesktopAgentConversationDetailMode | null;
  readonly changingAgentDockLayout: DesktopAgentDockLayout | null;
  readonly changingAppCatalogChannel: DesktopAppCatalogChannel | null;
  readonly changingBrowserUseConnectionMode: DesktopBrowserUseConnectionMode | null;
  readonly changingDockIconStyle: DesktopDockIconStyle | null;
  readonly changingDockPlacement: DesktopDockPlacement | null;
  readonly changingLocale: DesktopLocale | null;
  readonly changingMinimizeAnimation: DesktopMinimizeAnimation | null;
  readonly changingSleepPreventionMode: DesktopSleepPreventionMode | null;
  readonly changingShowAppDeveloperSources: boolean | null;
  readonly changingThemeSource: DesktopThemeSource | null;
  readonly changingUpdateChannel: DesktopUpdateChannel | null;
  readonly changingUpdatePolicy: DesktopUpdatePolicy | null;
  readonly changingWorkbenchWindowSnapping: DesktopWorkbenchWindowSnapping | null;
  readonly agentComposerDefaultsByProvider: DesktopAgentComposerDefaultsByProvider;
  readonly agentGuiConversationRailCollapsedByProvider: DesktopAgentGuiConversationRailCollapsedByProvider;
  readonly agentConversationDetailMode: DesktopAgentConversationDetailMode;
  readonly agentDockLayout: DesktopAgentDockLayout;
  readonly appCatalogChannel: DesktopAppCatalogChannel;
  readonly browserUseConnectionMode: DesktopBrowserUseConnectionMode;
  readonly defaultAgentProvider: DesktopAgentProvider;
  readonly dockIconStyle: DesktopDockIconStyle;
  readonly dockPlacement: DesktopDockPlacement;
  readonly fileDefaultOpenersByExtension: DesktopFileDefaultOpenersByExtension;
  readonly locale: DesktopLocale;
  readonly minimizeAnimation: DesktopMinimizeAnimation;
  readonly sleepPreventionMode: DesktopSleepPreventionMode;
  readonly showAppDeveloperSources: boolean;
  readonly theme: DesktopThemeState;
  readonly updateChannel: DesktopUpdateChannel;
  readonly updatePolicy: DesktopUpdatePolicy;
  readonly workbenchWindowSnapping: DesktopWorkbenchWindowSnapping;
}
