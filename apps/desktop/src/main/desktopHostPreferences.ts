import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  TuttidClient,
  PutDesktopPreferencesRequest
} from "@tutti-os/client-tuttid-ts";
import {
  defaultDesktopBrowserUseConnectionMode,
  defaultDesktopAppCatalogChannel,
  defaultDesktopAgentConversationDetailMode,
  defaultDesktopAgentDockLayout,
  desktopAgentComposerDefaultsByProviderEqual,
  desktopAgentGuiConversationRailCollapsedByProviderEqual,
  isDesktopBrowserUseConnectionMode,
  normalizeDesktopAgentDockLayout,
  normalizeDesktopAgentConversationDetailMode,
  normalizeDesktopAgentComposerDefaultsByProvider,
  normalizeDesktopAgentGuiConversationRailCollapsedByProvider,
  type DesktopAgentComposerDefaultsByProvider,
  type DesktopAgentGuiConversationRailCollapsedByProvider,
  defaultDesktopAgentProvider,
  defaultDesktopDockIconStyle,
  defaultDesktopDockPlacement,
  defaultDesktopFileDefaultOpenersByExtension,
  defaultDesktopMinimizeAnimation,
  defaultDesktopShowAppDeveloperSources,
  defaultDesktopSleepPreventionMode,
  defaultDesktopUpdateChannel,
  defaultDesktopUpdatePolicy,
  desktopFileDefaultOpenersByExtensionEqual,
  isDesktopMinimizeAnimation,
  normalizeDesktopWorkbenchWindowSnapping,
  desktopWorkbenchWindowSnappingEqual,
  type DesktopAgentProvider,
  type DesktopAgentConversationDetailMode,
  type DesktopAgentDockLayout,
  type DesktopAppCatalogChannel,
  type DesktopBrowserUseConnectionMode,
  type DesktopDockIconStyle,
  type DesktopDockPlacement,
  type DesktopFileDefaultOpenersByExtension,
  type DesktopMinimizeAnimation,
  type DesktopSleepPreventionMode,
  type DesktopUpdateChannel,
  type DesktopUpdatePolicy,
  type DesktopWorkbenchWindowSnapping
} from "../shared/preferences/index.ts";
import {
  defaultDesktopThemeSource,
  type DesktopThemeSource
} from "../shared/theme/index.ts";
import type { DesktopLocale } from "../shared/i18n/index.ts";
import type { DesktopLogger } from "./logging.ts";
import { resolveDesktopDefaultsFromEnv } from "./defaults.ts";

const updateChannelDefaultMigrationID =
  "desktop-update-channel-default-stable-v1";

export interface DesktopHostPreferencesState {
  getAgentComposerDefaultsByProvider(): DesktopAgentComposerDefaultsByProvider;
  getAgentGUIConversationRailCollapsedByProvider(): DesktopAgentGuiConversationRailCollapsedByProvider;
  getAgentConversationDetailMode(): DesktopAgentConversationDetailMode;
  getAgentDockLayout(): DesktopAgentDockLayout;
  getAppCatalogChannel(): DesktopAppCatalogChannel;
  getBrowserUseConnectionMode(): DesktopBrowserUseConnectionMode;
  getDefaultAgentProvider(): DesktopAgentProvider;
  getDockIconStyle(): DesktopDockIconStyle;
  getDockPlacement(): DesktopDockPlacement;
  getFileDefaultOpenersByExtension(): DesktopFileDefaultOpenersByExtension;
  getLocale(): DesktopLocale;
  getMinimizeAnimation(): DesktopMinimizeAnimation;
  getSleepPreventionMode(): DesktopSleepPreventionMode;
  getThemeSource(): DesktopThemeSource;
  getUpdateChannel(): DesktopUpdateChannel;
  getUpdatePolicy(): DesktopUpdatePolicy;
  getWorkbenchWindowSnapping(): DesktopWorkbenchWindowSnapping;
  subscribe(listener: () => void): () => void;
  sync(input: {
    agentComposerDefaultsByProvider?: DesktopAgentComposerDefaultsByProvider;
    agentGuiConversationRailCollapsedByProvider?: DesktopAgentGuiConversationRailCollapsedByProvider;
    agentConversationDetailMode?: DesktopAgentConversationDetailMode;
    agentDockLayout?: DesktopAgentDockLayout;
    appCatalogChannel?: DesktopAppCatalogChannel;
    browserUseConnectionMode?: DesktopBrowserUseConnectionMode;
    defaultAgentProvider?: DesktopAgentProvider;
    dockIconStyle?: DesktopDockIconStyle;
    dockPlacement?: DesktopDockPlacement;
    fileDefaultOpenersByExtension?: DesktopFileDefaultOpenersByExtension;
    locale?: DesktopLocale;
    minimizeAnimation?: DesktopMinimizeAnimation;
    sleepPreventionMode?: DesktopSleepPreventionMode;
    themeSource?: DesktopThemeSource;
    updateChannel?: DesktopUpdateChannel;
    updatePolicy?: DesktopUpdatePolicy;
    workbenchWindowSnapping?: DesktopWorkbenchWindowSnapping;
  }): void;
}

export interface CreateDesktopHostPreferencesOptions {
  appVersion?: string;
  fallbackLocale: DesktopLocale;
  logger: DesktopLogger;
  migrationStateRootDir?: string;
  tuttidClient: Pick<
    TuttidClient,
    "getDesktopPreferences" | "putDesktopPreferences"
  >;
}

export async function createDesktopHostPreferencesState(
  options: CreateDesktopHostPreferencesOptions
): Promise<DesktopHostPreferencesState> {
  const initialPreferences = await resolveInitialDesktopPreferences(options);
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
  let agentDockLayout = normalizeDesktopAgentDockLayout(
    initialPreferences.agentDockLayout
  );
  let appCatalogChannel =
    initialPreferences.appCatalogChannel ?? defaultDesktopAppCatalogChannel;
  let browserUseConnectionMode = isDesktopBrowserUseConnectionMode(
    initialPreferences.browserUseConnectionMode
  )
    ? initialPreferences.browserUseConnectionMode
    : defaultDesktopBrowserUseConnectionMode;
  let defaultAgentProvider = initialPreferences.defaultAgentProvider;
  let dockIconStyle = initialPreferences.dockIconStyle;
  let dockPlacement = initialPreferences.dockPlacement;
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
  let workbenchWindowSnapping = normalizeDesktopWorkbenchWindowSnapping(
    initialPreferences.workbenchWindowSnapping
  );
  const listeners = new Set<() => void>();

  return {
    getAgentComposerDefaultsByProvider() {
      return agentComposerDefaultsByProvider;
    },
    getAgentGUIConversationRailCollapsedByProvider() {
      return agentGUIConversationRailCollapsedByProvider;
    },
    getAgentConversationDetailMode() {
      return agentConversationDetailMode;
    },
    getAgentDockLayout() {
      return agentDockLayout;
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
    getWorkbenchWindowSnapping() {
      return workbenchWindowSnapping;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sync(input) {
      const previousAgentComposerDefaultsByProvider =
        agentComposerDefaultsByProvider;
      const previousAgentGUIConversationRailCollapsedByProvider =
        agentGUIConversationRailCollapsedByProvider;
      const previousAgentConversationDetailMode = agentConversationDetailMode;
      const previousAgentDockLayout = agentDockLayout;
      const previousAppCatalogChannel = appCatalogChannel;
      const previousBrowserUseConnectionMode = browserUseConnectionMode;
      const previousDefaultAgentProvider = defaultAgentProvider;
      const previousDockIconStyle = dockIconStyle;
      const previousDockPlacement = dockPlacement;
      const previousFileDefaultOpenersByExtension =
        fileDefaultOpenersByExtension;
      const previousLocale = locale;
      const previousMinimizeAnimation = minimizeAnimation;
      const previousSleepPreventionMode = sleepPreventionMode;
      const previousThemeSource = themeSource;
      const previousUpdateChannel = updateChannel;
      const previousUpdatePolicy = updatePolicy;
      const previousWorkbenchWindowSnapping = workbenchWindowSnapping;
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
      if (input.agentDockLayout) {
        agentDockLayout = normalizeDesktopAgentDockLayout(
          input.agentDockLayout
        );
      }
      if (input.browserUseConnectionMode) {
        browserUseConnectionMode = input.browserUseConnectionMode;
      }
      if (input.appCatalogChannel) {
        appCatalogChannel = input.appCatalogChannel;
      }
      if (input.defaultAgentProvider) {
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
        agentComposerDefaultsByProvider !==
          previousAgentComposerDefaultsByProvider ||
        agentGUIConversationRailCollapsedByProvider !==
          previousAgentGUIConversationRailCollapsedByProvider ||
        agentConversationDetailMode !== previousAgentConversationDetailMode ||
        agentDockLayout !== previousAgentDockLayout ||
        appCatalogChannel !== previousAppCatalogChannel ||
        browserUseConnectionMode !== previousBrowserUseConnectionMode ||
        defaultAgentProvider !== previousDefaultAgentProvider ||
        dockIconStyle !== previousDockIconStyle ||
        dockPlacement !== previousDockPlacement ||
        fileDefaultOpenersByExtension !==
          previousFileDefaultOpenersByExtension ||
        locale !== previousLocale ||
        minimizeAnimation !== previousMinimizeAnimation ||
        sleepPreventionMode !== previousSleepPreventionMode ||
        themeSource !== previousThemeSource ||
        updateChannel !== previousUpdateChannel ||
        updatePolicy !== previousUpdatePolicy ||
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
}

async function resolveInitialDesktopPreferences(
  options: CreateDesktopHostPreferencesOptions
): Promise<PutDesktopPreferencesRequest["preferences"]> {
  const defaultUpdateChannel = resolveDefaultDesktopUpdateChannel(options);
  try {
    const response = await options.tuttidClient.getDesktopPreferences();
    if (response.initialized) {
      return migrateInitializedDesktopPreferences(
        options,
        response.preferences,
        defaultUpdateChannel
      );
    }

    return (
      await options.tuttidClient.putDesktopPreferences({
        preferences: {
          agentComposerDefaultsByProvider: {},
          agentGuiConversationRailCollapsedByProvider: {},
          agentConversationDetailMode:
            defaultDesktopAgentConversationDetailMode,
          agentDockLayout: defaultDesktopAgentDockLayout,
          appCatalogChannel: defaultDesktopAppCatalogChannel,
          browserUseConnectionMode: defaultDesktopBrowserUseConnectionMode,
          defaultAgentProvider: defaultDesktopAgentProvider,
          dockIconStyle: defaultDesktopDockIconStyle,
          dockPlacement: defaultDesktopDockPlacement,
          fileDefaultOpenersByExtension:
            defaultDesktopFileDefaultOpenersByExtension,
          locale: options.fallbackLocale,
          minimizeAnimation: defaultDesktopMinimizeAnimation,
          showAppDeveloperSources: defaultDesktopShowAppDeveloperSources,
          sleepPreventionMode: defaultDesktopSleepPreventionMode,
          themeSource: defaultDesktopThemeSource,
          updateChannel: defaultUpdateChannel,
          updatePolicy: defaultDesktopUpdatePolicy
        }
      })
    ).preferences;
  } catch (error) {
    options.logger.warn("failed to resolve desktop preferences from tuttid", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      agentComposerDefaultsByProvider: {},
      agentGuiConversationRailCollapsedByProvider: {},
      agentConversationDetailMode: defaultDesktopAgentConversationDetailMode,
      agentDockLayout: defaultDesktopAgentDockLayout,
      appCatalogChannel: defaultDesktopAppCatalogChannel,
      browserUseConnectionMode: defaultDesktopBrowserUseConnectionMode,
      defaultAgentProvider: defaultDesktopAgentProvider,
      dockIconStyle: defaultDesktopDockIconStyle,
      dockPlacement: defaultDesktopDockPlacement,
      fileDefaultOpenersByExtension:
        defaultDesktopFileDefaultOpenersByExtension,
      locale: options.fallbackLocale,
      minimizeAnimation: defaultDesktopMinimizeAnimation,
      showAppDeveloperSources: defaultDesktopShowAppDeveloperSources,
      sleepPreventionMode: defaultDesktopSleepPreventionMode,
      themeSource: defaultDesktopThemeSource,
      updateChannel: defaultUpdateChannel,
      updatePolicy: defaultDesktopUpdatePolicy
    };
  }
}

async function migrateInitializedDesktopPreferences(
  options: CreateDesktopHostPreferencesOptions,
  preferences: PutDesktopPreferencesRequest["preferences"],
  defaultUpdateChannel: DesktopUpdateChannel
): Promise<PutDesktopPreferencesRequest["preferences"]> {
  const normalizedMinimizeAnimation = isDesktopMinimizeAnimation(
    preferences.minimizeAnimation
  )
    ? preferences.minimizeAnimation
    : defaultDesktopMinimizeAnimation;
  const normalizedAgentConversationDetailMode =
    normalizeDesktopAgentConversationDetailMode(
      preferences.agentConversationDetailMode
    );
  const normalizedAgentDockLayout = normalizeDesktopAgentDockLayout(
    preferences.agentDockLayout
  );
  if (
    preferences.updateChannel !== "rc" ||
    defaultUpdateChannel !== "stable"
  ) {
    if (
      preferences.minimizeAnimation === normalizedMinimizeAnimation &&
      preferences.agentConversationDetailMode ===
        normalizedAgentConversationDetailMode &&
      preferences.agentDockLayout === normalizedAgentDockLayout
    ) {
      return preferences;
    }
    return {
      ...preferences,
      agentConversationDetailMode: normalizedAgentConversationDetailMode,
      agentDockLayout: normalizedAgentDockLayout,
      minimizeAnimation: normalizedMinimizeAnimation
    };
  }

  const markerPath = resolveUpdateChannelDefaultMigrationMarkerPath(options);
  if (await hasMigrationMarker(markerPath)) {
    if (
      preferences.minimizeAnimation === normalizedMinimizeAnimation &&
      preferences.agentConversationDetailMode ===
        normalizedAgentConversationDetailMode &&
      preferences.agentDockLayout === normalizedAgentDockLayout
    ) {
      return preferences;
    }
    return {
      ...preferences,
      agentConversationDetailMode: normalizedAgentConversationDetailMode,
      agentDockLayout: normalizedAgentDockLayout,
      minimizeAnimation: normalizedMinimizeAnimation
    };
  }

  try {
    const response = await options.tuttidClient.putDesktopPreferences({
      preferences: {
        ...preferences,
        agentConversationDetailMode: normalizedAgentConversationDetailMode,
        agentDockLayout: normalizedAgentDockLayout,
        minimizeAnimation: normalizedMinimizeAnimation,
        updateChannel: defaultUpdateChannel
      }
    });
    await writeMigrationMarker(markerPath);
    return response.preferences;
  } catch (error) {
    options.logger.warn("failed to migrate default desktop update channel", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      ...preferences,
      agentConversationDetailMode: normalizedAgentConversationDetailMode,
      agentDockLayout: normalizedAgentDockLayout,
      minimizeAnimation: normalizedMinimizeAnimation
    };
  }
}

function resolveDefaultDesktopUpdateChannel(
  options: CreateDesktopHostPreferencesOptions
): DesktopUpdateChannel {
  const version = options.appVersion?.trim().replace(/^v/iu, "") ?? "";
  if (/^\d+\.\d+\.\d+-rc\.\d+$/u.test(version)) {
    return "rc";
  }

  return defaultDesktopUpdateChannel;
}

function resolveUpdateChannelDefaultMigrationMarkerPath(
  options: CreateDesktopHostPreferencesOptions
): string {
  const stateRootDir =
    options.migrationStateRootDir ??
    resolveDesktopDefaultsFromEnv().state.rootDir;
  return join(stateRootDir, "migrations", updateChannelDefaultMigrationID);
}

async function hasMigrationMarker(markerPath: string): Promise<boolean> {
  try {
    await readFile(markerPath, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function writeMigrationMarker(markerPath: string): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, new Date().toISOString(), "utf8");
}
