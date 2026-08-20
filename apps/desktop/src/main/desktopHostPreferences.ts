import type { DesktopPreferencesStateResponse } from "@tutti-os/client-tuttid-ts";
import {
  defaultDesktopBrowserUseConnectionMode,
  defaultDesktopAppCatalogChannel,
  desktopAgentComposerDefaultsByProviderEqual,
  desktopAgentGuiConversationRailCollapsedByProviderEqual,
  isDesktopBrowserUseConnectionMode,
  normalizeDesktopAgentConversationDetailMode,
  normalizeDesktopAgentCliUpdateCheckEnabled,
  normalizeDesktopAgentComposerDefaultsByProvider,
  normalizeDesktopAgentGuiConversationRailCollapsedByProvider,
  isDesktopDefaultAgentProvider,
  type DesktopAgentComposerDefaultsByProvider,
  type DesktopAgentGuiConversationRailCollapsedByProvider,
  defaultDesktopAgentProvider,
  defaultDesktopFileDefaultOpenersByExtension,
  defaultDesktopMinimizeAnimation,
  isDesktopMinimizeAnimation,
  desktopFeatureFlagsEqual,
  desktopFileDefaultOpenersByExtensionEqual,
  desktopWorkbenchShortcutsEqual,
  normalizeDesktopFeatureFlags,
  normalizeDesktopWorkbenchShortcuts,
  normalizeDesktopWorkbenchWindowSnapping,
  desktopWorkbenchWindowSnappingEqual,
  type DesktopDefaultAgentProvider,
  type DesktopAgentConversationDetailMode,
  type DesktopAppCatalogChannel,
  type DesktopBrowserUseConnectionMode,
  type DesktopDockIconStyle,
  type DesktopDockPlacement,
  type DesktopFeatureFlags,
  type DesktopFileDefaultOpenersByExtension,
  type DesktopMinimizeAnimation,
  type DesktopSleepPreventionMode,
  type DesktopUpdateChannel,
  type DesktopUpdatePolicy,
  type DesktopWorkbenchShortcuts,
  type DesktopWorkbenchShortcutsInput,
  type DesktopWorkbenchWindowSnapping
} from "../shared/preferences/index.ts";
import type { DesktopThemeSource } from "../shared/theme/index.ts";
import type { DesktopLocale } from "../shared/i18n/index.ts";
import {
  createDesktopHostPreferencesInitialization,
  type CreateDesktopHostPreferencesOptions
} from "./desktopHostPreferencesInitialization.ts";

export type { CreateDesktopHostPreferencesOptions } from "./desktopHostPreferencesInitialization.ts";

export interface DesktopHostPreferencesState {
  ensureInitialized(): Promise<DesktopPreferencesStateResponse>;
  getAgentCliUpdateCheckEnabled(): boolean;
  getAgentComposerDefaultsByProvider(): DesktopAgentComposerDefaultsByProvider;
  getAgentGUIConversationRailCollapsedByProvider(): DesktopAgentGuiConversationRailCollapsedByProvider;
  getAgentConversationDetailMode(): DesktopAgentConversationDetailMode;
  getAppCatalogChannel(): DesktopAppCatalogChannel;
  getBrowserUseConnectionMode(): DesktopBrowserUseConnectionMode;
  getDefaultAgentProvider(): DesktopDefaultAgentProvider;
  getDockIconStyle(): DesktopDockIconStyle;
  getDockPlacement(): DesktopDockPlacement;
  getFeatureFlags(): DesktopFeatureFlags;
  getFileDefaultOpenersByExtension(): DesktopFileDefaultOpenersByExtension;
  getLocale(): DesktopLocale;
  getMinimizeAnimation(): DesktopMinimizeAnimation;
  getSleepPreventionMode(): DesktopSleepPreventionMode;
  getThemeSource(): DesktopThemeSource;
  getUpdateChannel(): DesktopUpdateChannel;
  getUpdatePolicy(): DesktopUpdatePolicy;
  getWorkbenchShortcuts(): DesktopWorkbenchShortcuts;
  getWorkbenchWindowSnapping(): DesktopWorkbenchWindowSnapping;
  subscribe(listener: () => void): () => void;
  syncAuthoritative(
    preferences: DesktopPreferencesStateResponse["preferences"]
  ): void;
  sync(input: {
    agentCliUpdateCheckEnabled?: boolean;
    agentComposerDefaultsByProvider?: DesktopAgentComposerDefaultsByProvider;
    agentGuiConversationRailCollapsedByProvider?: DesktopAgentGuiConversationRailCollapsedByProvider;
    agentConversationDetailMode?: DesktopAgentConversationDetailMode;
    appCatalogChannel?: DesktopAppCatalogChannel;
    browserUseConnectionMode?: DesktopBrowserUseConnectionMode;
    defaultAgentProvider?: DesktopDefaultAgentProvider;
    dockIconStyle?: DesktopDockIconStyle;
    dockPlacement?: DesktopDockPlacement;
    featureFlags?: DesktopFeatureFlags;
    fileDefaultOpenersByExtension?: DesktopFileDefaultOpenersByExtension;
    locale?: DesktopLocale;
    minimizeAnimation?: DesktopMinimizeAnimation;
    sleepPreventionMode?: DesktopSleepPreventionMode;
    themeSource?: DesktopThemeSource;
    updateChannel?: DesktopUpdateChannel;
    updatePolicy?: DesktopUpdatePolicy;
    workbenchShortcuts?: DesktopWorkbenchShortcutsInput;
    workbenchWindowSnapping?: DesktopWorkbenchWindowSnapping;
  }): void;
}

export async function createDesktopHostPreferencesState(
  options: CreateDesktopHostPreferencesOptions
): Promise<DesktopHostPreferencesState> {
  const initialization =
    await createDesktopHostPreferencesInitialization(options);
  const initialPreferences = initialization.initialPreferences;
  let agentCliUpdateCheckEnabled = normalizeDesktopAgentCliUpdateCheckEnabled(
    initialPreferences.agentCliUpdateCheckEnabled
  );
  let agentComposerDefaultsByProvider =
    normalizeDesktopAgentComposerDefaultsByProvider(
      initialPreferences.agentComposerDefaultsByProvider
    );
  let agentGUIConversationRailCollapsedByProvider =
    normalizeDesktopAgentGuiConversationRailCollapsedByProvider(
      initialPreferences.agentGuiConversationRailCollapsedByProvider
    );
  let agentConversationDetailMode = normalizeDesktopAgentConversationDetailMode(
    initialPreferences.agentConversationDetailMode
  );
  let appCatalogChannel =
    initialPreferences.appCatalogChannel ?? defaultDesktopAppCatalogChannel;
  let browserUseConnectionMode = isDesktopBrowserUseConnectionMode(
    initialPreferences.browserUseConnectionMode
  )
    ? initialPreferences.browserUseConnectionMode
    : defaultDesktopBrowserUseConnectionMode;
  let defaultAgentProvider = normalizeDesktopDefaultAgentProvider(
    initialPreferences.defaultAgentProvider
  );
  let dockIconStyle = initialPreferences.dockIconStyle;
  let dockPlacement = initialPreferences.dockPlacement;
  let featureFlags = normalizeDesktopFeatureFlags(
    initialPreferences.featureFlags
  );
  let fileDefaultOpenersByExtension =
    initialPreferences.fileDefaultOpenersByExtension ??
    defaultDesktopFileDefaultOpenersByExtension;
  let locale = initialPreferences.locale;
  let minimizeAnimation = isDesktopMinimizeAnimation(
    initialPreferences.minimizeAnimation
  )
    ? initialPreferences.minimizeAnimation
    : defaultDesktopMinimizeAnimation;
  let sleepPreventionMode = initialPreferences.sleepPreventionMode;
  let themeSource = initialPreferences.themeSource;
  let updateChannel = initialPreferences.updateChannel;
  let updatePolicy = initialPreferences.updatePolicy;
  let workbenchShortcuts = normalizeDesktopWorkbenchShortcuts(
    initialPreferences.workbenchShortcuts
  );
  let workbenchWindowSnapping = normalizeDesktopWorkbenchWindowSnapping(
    initialPreferences.workbenchWindowSnapping
  );
  const listeners = new Set<() => void>();

  const state: DesktopHostPreferencesState = {
    async ensureInitialized() {
      const response = await initialization.ensureInitialized();
      state.sync(response.preferences);
      return response;
    },
    getAgentCliUpdateCheckEnabled() {
      return agentCliUpdateCheckEnabled;
    },
    getAgentComposerDefaultsByProvider() {
      return agentComposerDefaultsByProvider;
    },
    getAgentGUIConversationRailCollapsedByProvider() {
      return agentGUIConversationRailCollapsedByProvider;
    },
    getAgentConversationDetailMode() {
      return agentConversationDetailMode;
    },
    getAppCatalogChannel() {
      return appCatalogChannel;
    },
    getBrowserUseConnectionMode() {
      return browserUseConnectionMode;
    },
    getDefaultAgentProvider() {
      return defaultAgentProvider;
    },
    getDockIconStyle() {
      return dockIconStyle;
    },
    getDockPlacement() {
      return dockPlacement;
    },
    getFeatureFlags() {
      return featureFlags;
    },
    getFileDefaultOpenersByExtension() {
      return fileDefaultOpenersByExtension;
    },
    getLocale() {
      return locale;
    },
    getMinimizeAnimation() {
      return minimizeAnimation;
    },
    getSleepPreventionMode() {
      return sleepPreventionMode;
    },
    getThemeSource() {
      return themeSource;
    },
    getUpdateChannel() {
      return updateChannel;
    },
    getUpdatePolicy() {
      return updatePolicy;
    },
    getWorkbenchShortcuts() {
      return workbenchShortcuts;
    },
    getWorkbenchWindowSnapping() {
      return workbenchWindowSnapping;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncAuthoritative(preferences) {
      initialization.observeAuthoritativePreferences(preferences);
      state.sync(preferences);
    },
    sync(input) {
      const previousAgentCliUpdateCheckEnabled = agentCliUpdateCheckEnabled;
      const previousAgentComposerDefaultsByProvider =
        agentComposerDefaultsByProvider;
      const previousAgentGUIConversationRailCollapsedByProvider =
        agentGUIConversationRailCollapsedByProvider;
      const previousAgentConversationDetailMode = agentConversationDetailMode;
      const previousAppCatalogChannel = appCatalogChannel;
      const previousBrowserUseConnectionMode = browserUseConnectionMode;
      const previousDefaultAgentProvider = defaultAgentProvider;
      const previousDockIconStyle = dockIconStyle;
      const previousDockPlacement = dockPlacement;
      const previousFeatureFlags = featureFlags;
      const previousFileDefaultOpenersByExtension =
        fileDefaultOpenersByExtension;
      const previousLocale = locale;
      const previousMinimizeAnimation = minimizeAnimation;
      const previousSleepPreventionMode = sleepPreventionMode;
      const previousThemeSource = themeSource;
      const previousUpdateChannel = updateChannel;
      const previousUpdatePolicy = updatePolicy;
      const previousWorkbenchShortcuts = workbenchShortcuts;
      const previousWorkbenchWindowSnapping = workbenchWindowSnapping;
      if (typeof input.agentCliUpdateCheckEnabled === "boolean") {
        agentCliUpdateCheckEnabled = input.agentCliUpdateCheckEnabled;
      }
      if (input.agentComposerDefaultsByProvider) {
        const nextAgentComposerDefaultsByProvider =
          normalizeDesktopAgentComposerDefaultsByProvider(
            input.agentComposerDefaultsByProvider
          );
        if (
          !desktopAgentComposerDefaultsByProviderEqual(
            agentComposerDefaultsByProvider,
            nextAgentComposerDefaultsByProvider
          )
        ) {
          agentComposerDefaultsByProvider = nextAgentComposerDefaultsByProvider;
        }
      }
      if (input.agentGuiConversationRailCollapsedByProvider) {
        const nextAgentGUIConversationRailCollapsedByProvider =
          normalizeDesktopAgentGuiConversationRailCollapsedByProvider(
            input.agentGuiConversationRailCollapsedByProvider
          );
        if (
          !desktopAgentGuiConversationRailCollapsedByProviderEqual(
            agentGUIConversationRailCollapsedByProvider,
            nextAgentGUIConversationRailCollapsedByProvider
          )
        ) {
          agentGUIConversationRailCollapsedByProvider =
            nextAgentGUIConversationRailCollapsedByProvider;
        }
      }
      if (input.agentConversationDetailMode) {
        agentConversationDetailMode =
          normalizeDesktopAgentConversationDetailMode(
            input.agentConversationDetailMode
          );
      }
      if (input.browserUseConnectionMode) {
        browserUseConnectionMode = input.browserUseConnectionMode;
      }
      if (input.appCatalogChannel) {
        appCatalogChannel = input.appCatalogChannel;
      }
      if (
        input.defaultAgentProvider &&
        isDesktopDefaultAgentProvider(input.defaultAgentProvider)
      ) {
        defaultAgentProvider = input.defaultAgentProvider;
      }
      if (input.dockIconStyle) {
        dockIconStyle = input.dockIconStyle;
      }
      if (input.dockPlacement) {
        dockPlacement = input.dockPlacement;
      }
      if (input.fileDefaultOpenersByExtension) {
        const nextFileDefaultOpenersByExtension =
          input.fileDefaultOpenersByExtension;
        if (
          !desktopFileDefaultOpenersByExtensionEqual(
            fileDefaultOpenersByExtension,
            nextFileDefaultOpenersByExtension
          )
        ) {
          fileDefaultOpenersByExtension = nextFileDefaultOpenersByExtension;
        }
      }
      if (input.featureFlags) {
        const nextFeatureFlags = normalizeDesktopFeatureFlags(
          input.featureFlags
        );
        if (!desktopFeatureFlagsEqual(featureFlags, nextFeatureFlags)) {
          featureFlags = nextFeatureFlags;
        }
      }
      if (input.locale) {
        locale = input.locale;
      }
      if (input.minimizeAnimation) {
        minimizeAnimation = input.minimizeAnimation;
      }
      if (input.sleepPreventionMode) {
        sleepPreventionMode = input.sleepPreventionMode;
      }
      if (input.themeSource) {
        themeSource = input.themeSource;
      }
      if (input.updateChannel) {
        updateChannel = input.updateChannel;
      }
      if (input.updatePolicy) {
        updatePolicy = input.updatePolicy;
      }
      if (input.workbenchShortcuts) {
        const nextWorkbenchShortcuts = normalizeDesktopWorkbenchShortcuts(
          input.workbenchShortcuts
        );
        if (
          !desktopWorkbenchShortcutsEqual(
            workbenchShortcuts,
            nextWorkbenchShortcuts
          )
        ) {
          workbenchShortcuts = nextWorkbenchShortcuts;
        }
      }
      if (input.workbenchWindowSnapping) {
        const nextWorkbenchWindowSnapping =
          normalizeDesktopWorkbenchWindowSnapping(
            input.workbenchWindowSnapping
          );
        if (
          !desktopWorkbenchWindowSnappingEqual(
            workbenchWindowSnapping,
            nextWorkbenchWindowSnapping
          )
        ) {
          workbenchWindowSnapping = nextWorkbenchWindowSnapping;
        }
      }
      if (
        agentCliUpdateCheckEnabled !== previousAgentCliUpdateCheckEnabled ||
        agentComposerDefaultsByProvider !==
          previousAgentComposerDefaultsByProvider ||
        agentGUIConversationRailCollapsedByProvider !==
          previousAgentGUIConversationRailCollapsedByProvider ||
        agentConversationDetailMode !== previousAgentConversationDetailMode ||
        appCatalogChannel !== previousAppCatalogChannel ||
        browserUseConnectionMode !== previousBrowserUseConnectionMode ||
        defaultAgentProvider !== previousDefaultAgentProvider ||
        dockIconStyle !== previousDockIconStyle ||
        dockPlacement !== previousDockPlacement ||
        !desktopFeatureFlagsEqual(featureFlags, previousFeatureFlags) ||
        fileDefaultOpenersByExtension !==
          previousFileDefaultOpenersByExtension ||
        locale !== previousLocale ||
        minimizeAnimation !== previousMinimizeAnimation ||
        sleepPreventionMode !== previousSleepPreventionMode ||
        themeSource !== previousThemeSource ||
        updateChannel !== previousUpdateChannel ||
        updatePolicy !== previousUpdatePolicy ||
        !desktopWorkbenchShortcutsEqual(
          workbenchShortcuts,
          previousWorkbenchShortcuts
        ) ||
        !desktopWorkbenchWindowSnappingEqual(
          workbenchWindowSnapping,
          previousWorkbenchWindowSnapping
        )
      ) {
        for (const listener of listeners) {
          listener();
        }
      }
    }
  };
  return state;
}

function normalizeDesktopDefaultAgentProvider(
  value: unknown
): DesktopDefaultAgentProvider {
  return isDesktopDefaultAgentProvider(value)
    ? value
    : defaultDesktopAgentProvider;
}
