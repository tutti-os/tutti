import type { DesktopLocale } from "@shared/i18n";
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";
import type { PutDesktopPreferencesRequest } from "@tutti-os/client-tuttid-ts";
import {
  defaultDesktopAppCatalogChannel,
  defaultDesktopBrowserUseConnectionMode,
  defaultDesktopMinimizeAnimation,
  defaultDesktopShowAppDeveloperSources,
  defaultDesktopWorkbenchWindowSnapping,
  desktopFeatureFlagsEqual,
  desktopWorkbenchShortcutsEqual,
  desktopWorkbenchWindowSnappingEqual,
  normalizeDeletedAgentConversationRetentionDays,
  normalizeDesktopAgentCliUpdateCheckEnabled,
  normalizeDesktopAgentComposerDefaultsByAgentTarget,
  normalizeDesktopAgentConversationDetailMode,
  normalizeDesktopAgentGuiConversationRailCollapsedByProvider,
  normalizeDesktopAgentSessionLaunchModesByWorkspace,
  normalizeDesktopFeatureFlags,
  normalizeDesktopFileDefaultOpenersByExtension,
  normalizeDesktopWorkbenchShortcuts,
  normalizeDesktopWorkbenchWindowSnapping
} from "../../../../../../shared/preferences/index.ts";
import type { DesktopPreferencesStoreState } from "../desktopPreferencesTypes.ts";

type DesktopPreferences = PutDesktopPreferencesRequest["preferences"];

export type DesktopPreferencesOverrides = Partial<DesktopPreferences>;

export function applyDesktopPreferencesProjection(input: {
  applyLocale: (locale: DesktopLocale) => void;
  applyTheme: (theme: DesktopThemeState) => void;
  preferences: DesktopPreferences;
  resolveTheme: (source: DesktopThemeSource) => DesktopThemeState;
  store: DesktopPreferencesStoreState;
}): void {
  const { preferences, store } = input;
  store.agentCliUpdateCheckEnabled = normalizeDesktopAgentCliUpdateCheckEnabled(
    preferences.agentCliUpdateCheckEnabled
  );
  store.agentComposerDefaultsByAgentTarget =
    normalizeDesktopAgentComposerDefaultsByAgentTarget(
      preferences.agentComposerDefaultsByAgentTarget
    );
  store.agentGuiConversationRailCollapsedByProvider =
    normalizeDesktopAgentGuiConversationRailCollapsedByProvider(
      preferences.agentGuiConversationRailCollapsedByProvider
    );
  store.agentSessionLaunchModesByWorkspace =
    normalizeDesktopAgentSessionLaunchModesByWorkspace(
      preferences.agentSessionLaunchModesByWorkspace
    );
  store.agentConversationDetailMode =
    normalizeDesktopAgentConversationDetailMode(
      preferences.agentConversationDetailMode
    );
  store.appCatalogChannel =
    preferences.appCatalogChannel ?? defaultDesktopAppCatalogChannel;
  store.browserUseConnectionMode =
    preferences.browserUseConnectionMode ??
    defaultDesktopBrowserUseConnectionMode;
  store.defaultAgentProvider = preferences.defaultAgentProvider;
  store.dockIconStyle = preferences.dockIconStyle;
  store.dockPlacement = preferences.dockPlacement;
  store.deletedAgentConversationRetentionDays =
    normalizeDeletedAgentConversationRetentionDays(
      preferences.deletedAgentConversationRetentionDays
    );
  store.fileDefaultOpenersByExtension =
    normalizeDesktopFileDefaultOpenersByExtension(
      preferences.fileDefaultOpenersByExtension
    );
  const nextFeatureFlags = normalizeDesktopFeatureFlags(
    preferences.featureFlags
  );
  if (!desktopFeatureFlagsEqual(store.featureFlags, nextFeatureFlags)) {
    store.featureFlags = nextFeatureFlags;
  }
  applyDesktopPreferenceLocale(store, preferences.locale, input.applyLocale);
  store.minimizeAnimation =
    preferences.minimizeAnimation ?? defaultDesktopMinimizeAnimation;
  store.sleepPreventionMode = preferences.sleepPreventionMode;
  store.showAppDeveloperSources =
    preferences.showAppDeveloperSources ??
    defaultDesktopShowAppDeveloperSources;
  applyDesktopPreferenceTheme(
    store,
    input.resolveTheme(preferences.themeSource),
    input.applyTheme
  );
  store.updateChannel = preferences.updateChannel;
  store.updatePolicy = preferences.updatePolicy;
  const nextWorkbenchShortcuts = normalizeDesktopWorkbenchShortcuts(
    preferences.workbenchShortcuts
  );
  if (
    !desktopWorkbenchShortcutsEqual(
      store.workbenchShortcuts,
      nextWorkbenchShortcuts
    )
  ) {
    store.workbenchShortcuts = nextWorkbenchShortcuts;
  }
  store.workbenchWindowSnapping = normalizeDesktopWorkbenchWindowSnapping(
    preferences.workbenchWindowSnapping
  );
}

export function createDesktopPreferencesMutation(
  store: DesktopPreferencesStoreState,
  overrides: DesktopPreferencesOverrides = {}
): DesktopPreferences {
  const hasWorkbenchWindowSnappingOverride =
    "workbenchWindowSnapping" in overrides;
  const hasAgentSessionLaunchModesOverride =
    "agentSessionLaunchModesByWorkspace" in overrides;
  const agentSessionLaunchModesByWorkspace =
    normalizeDesktopAgentSessionLaunchModesByWorkspace(
      overrides.agentSessionLaunchModesByWorkspace ??
        store.agentSessionLaunchModesByWorkspace
    );
  const workbenchWindowSnapping = normalizeDesktopWorkbenchWindowSnapping(
    overrides.workbenchWindowSnapping ?? store.workbenchWindowSnapping
  );
  return {
    agentCliUpdateCheckEnabled:
      overrides.agentCliUpdateCheckEnabled ?? store.agentCliUpdateCheckEnabled,
    // Keep the required wire-contract field, but stop round-tripping the
    // frozen legacy provider-keyed defaults through renderer state.
    agentComposerDefaultsByProvider: {},
    agentGuiConversationRailCollapsedByProvider:
      normalizeDesktopAgentGuiConversationRailCollapsedByProvider(
        overrides.agentGuiConversationRailCollapsedByProvider ??
          store.agentGuiConversationRailCollapsedByProvider
      ),
    ...(hasAgentSessionLaunchModesOverride ||
    Object.keys(agentSessionLaunchModesByWorkspace).length > 0
      ? { agentSessionLaunchModesByWorkspace }
      : {}),
    agentConversationDetailMode: normalizeDesktopAgentConversationDetailMode(
      overrides.agentConversationDetailMode ?? store.agentConversationDetailMode
    ),
    // The dual-dock (legacySplit) layout has been removed; the stored
    // preference is pinned to the unified layout.
    agentDockLayout: "unified",
    appCatalogChannel: overrides.appCatalogChannel ?? store.appCatalogChannel,
    browserUseConnectionMode:
      overrides.browserUseConnectionMode ?? store.browserUseConnectionMode,
    defaultAgentProvider:
      overrides.defaultAgentProvider ?? store.defaultAgentProvider,
    dockIconStyle: overrides.dockIconStyle ?? store.dockIconStyle,
    dockPlacement: overrides.dockPlacement ?? store.dockPlacement,
    deletedAgentConversationRetentionDays:
      overrides.deletedAgentConversationRetentionDays ??
      store.deletedAgentConversationRetentionDays,
    featureFlags: normalizeDesktopFeatureFlags(
      overrides.featureFlags ?? store.featureFlags
    ),
    fileDefaultOpenersByExtension:
      normalizeDesktopFileDefaultOpenersByExtension(
        overrides.fileDefaultOpenersByExtension ??
          store.fileDefaultOpenersByExtension
      ),
    locale: overrides.locale ?? store.locale,
    minimizeAnimation: overrides.minimizeAnimation ?? store.minimizeAnimation,
    sleepPreventionMode:
      overrides.sleepPreventionMode ?? store.sleepPreventionMode,
    showAppDeveloperSources:
      overrides.showAppDeveloperSources ?? store.showAppDeveloperSources,
    themeSource: overrides.themeSource ?? store.theme.source,
    updateChannel: overrides.updateChannel ?? store.updateChannel,
    updatePolicy: overrides.updatePolicy ?? store.updatePolicy,
    workbenchShortcuts: normalizeDesktopWorkbenchShortcuts(
      overrides.workbenchShortcuts ?? store.workbenchShortcuts
    ),
    ...(hasWorkbenchWindowSnappingOverride ||
    !desktopWorkbenchWindowSnappingEqual(
      workbenchWindowSnapping,
      defaultDesktopWorkbenchWindowSnapping
    )
      ? { workbenchWindowSnapping }
      : {})
  };
}

export function applyDesktopPreferenceLocale(
  store: DesktopPreferencesStoreState,
  locale: DesktopLocale,
  apply: (locale: DesktopLocale) => void
): void {
  if (store.locale === locale) {
    return;
  }
  apply(locale);
  store.locale = locale;
}

export function applyDesktopPreferenceTheme(
  store: DesktopPreferencesStoreState,
  theme: DesktopThemeState,
  apply: (theme: DesktopThemeState) => void
): void {
  if (
    store.theme.appearance === theme.appearance &&
    store.theme.source === theme.source
  ) {
    return;
  }
  apply(theme);
  store.theme = theme;
}
