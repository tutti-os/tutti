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
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";

export interface DesktopPreferencesStoreState {
  changingDefaultAgentProvider: DesktopDefaultAgentProvider | null;
  changingAgentConversationDetailMode: DesktopAgentConversationDetailMode | null;
  changingAppCatalogChannel: DesktopAppCatalogChannel | null;
  changingBrowserUseConnectionMode: DesktopBrowserUseConnectionMode | null;
  changingDockIconStyle: DesktopDockIconStyle | null;
  changingDockPlacement: DesktopDockPlacement | null;
  changingDeletedAgentConversationRetentionDays: DeletedAgentConversationRetentionDays | null;
  changingLocale: DesktopLocale | null;
  changingFeatureFlags: DesktopFeatureFlags | null;
  changingMinimizeAnimation: DesktopMinimizeAnimation | null;
  changingSleepPreventionMode: DesktopSleepPreventionMode | null;
  changingShowAppDeveloperSources: boolean | null;
  changingThemeSource: DesktopThemeSource | null;
  changingUpdateChannel: DesktopUpdateChannel | null;
  changingUpdatePolicy: DesktopUpdatePolicy | null;
  changingWorkbenchWindowSnapping: DesktopWorkbenchWindowSnapping | null;
  agentComposerDefaultsByProvider: DesktopAgentComposerDefaultsByProvider;
  agentComposerDefaultsByAgentTarget: DesktopAgentComposerDefaultsByAgentTarget;
  agentGuiConversationRailCollapsedByProvider: DesktopAgentGuiConversationRailCollapsedByProvider;
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
}

export interface DesktopPreferencesReadableStoreState {
  readonly changingDefaultAgentProvider: DesktopDefaultAgentProvider | null;
  readonly changingAgentConversationDetailMode: DesktopAgentConversationDetailMode | null;
  readonly changingAppCatalogChannel: DesktopAppCatalogChannel | null;
  readonly changingBrowserUseConnectionMode: DesktopBrowserUseConnectionMode | null;
  readonly changingDockIconStyle: DesktopDockIconStyle | null;
  readonly changingDockPlacement: DesktopDockPlacement | null;
  readonly changingDeletedAgentConversationRetentionDays: DeletedAgentConversationRetentionDays | null;
  readonly changingLocale: DesktopLocale | null;
  readonly changingFeatureFlags: DesktopFeatureFlags | null;
  readonly changingMinimizeAnimation: DesktopMinimizeAnimation | null;
  readonly changingSleepPreventionMode: DesktopSleepPreventionMode | null;
  readonly changingShowAppDeveloperSources: boolean | null;
  readonly changingThemeSource: DesktopThemeSource | null;
  readonly changingUpdateChannel: DesktopUpdateChannel | null;
  readonly changingUpdatePolicy: DesktopUpdatePolicy | null;
  readonly changingWorkbenchWindowSnapping: DesktopWorkbenchWindowSnapping | null;
  readonly agentComposerDefaultsByProvider: DesktopAgentComposerDefaultsByProvider;
  readonly agentComposerDefaultsByAgentTarget: DesktopAgentComposerDefaultsByAgentTarget;
  readonly agentGuiConversationRailCollapsedByProvider: DesktopAgentGuiConversationRailCollapsedByProvider;
  readonly agentConversationDetailMode: DesktopAgentConversationDetailMode;
  readonly appCatalogChannel: DesktopAppCatalogChannel;
  readonly browserUseConnectionMode: DesktopBrowserUseConnectionMode;
  readonly defaultAgentProvider: DesktopDefaultAgentProvider;
  readonly dockIconStyle: DesktopDockIconStyle;
  readonly dockPlacement: DesktopDockPlacement;
  readonly deletedAgentConversationRetentionDays: DeletedAgentConversationRetentionDays;
  readonly featureFlags: DesktopFeatureFlags;
  readonly fileDefaultOpenersByExtension: DesktopFileDefaultOpenersByExtension;
  readonly locale: DesktopLocale;
  readonly minimizeAnimation: DesktopMinimizeAnimation;
  readonly sleepPreventionMode: DesktopSleepPreventionMode;
  readonly showAppDeveloperSources: boolean;
  readonly theme: DesktopThemeState;
  readonly updateChannel: DesktopUpdateChannel;
  readonly updatePolicy: DesktopUpdatePolicy;
  readonly workbenchShortcuts: DesktopWorkbenchShortcuts;
  readonly workbenchWindowSnapping: DesktopWorkbenchWindowSnapping;
}
