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
  desktopAgentComposerDefaultsByProviderEqual,
  desktopAgentGuiConversationRailCollapsedByProviderEqual,
  isDesktopBrowserUseConnectionMode,
  normalizeDesktopAgentConversationDetailMode,
  normalizeDesktopAgentComposerDefaultsByProvider,
  normalizeDesktopAgentGuiConversationRailCollapsedByProvider,
  isDesktopDefaultAgentProvider,
  type DesktopAgentComposerDefaultsByProvider,
  type DesktopAgentGuiConversationRailCollapsedByProvider,
  defaultDesktopAgentProvider,
  defaultDesktopDockIconStyle,
  defaultDesktopDockPlacement,
  defaultDeletedAgentConversationRetentionDays,
  defaultDesktopFeatureFlags,
  defaultDesktopFileDefaultOpenersByExtension,
  defaultDesktopMinimizeAnimation,
  defaultDesktopShowAppDeveloperSources,
  defaultDesktopSleepPreventionMode,
  defaultDesktopUpdateChannel,
  defaultDesktopUpdatePolicy,
  defaultDesktopWorkbenchShortcuts,
  desktopFeatureFlagsEqual,
  desktopFileDefaultOpenersByExtensionEqual,
  desktopWorkbenchShortcutsEqual,
  isDesktopMinimizeAnimation,
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
const updateChannelInstalledVersionStateID =
  "desktop-update-channel-installed-version-v1";

export interface DesktopHostPreferencesState {
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
  sync(input: {
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
    workbenchShortcuts?: DesktopWorkbenchShortcuts;
    workbenchWindowSnapping?: DesktopWorkbenchWindowSnapping;
  }): void;
}

export interface CreateDesktopHostPreferencesOptions {
  appVersion?: string;
  fallbackLocale: DesktopLocale;
  isPackaged?: boolean;
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
    sync(input) {
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
}

function normalizeDesktopDefaultAgentProvider(
  value: unknown
): DesktopDefaultAgentProvider {
  return isDesktopDefaultAgentProvider(value)
    ? value
    : defaultDesktopAgentProvider;
}

async function resolveInitialDesktopPreferences(
  options: CreateDesktopHostPreferencesOptions
): Promise<PutDesktopPreferencesRequest["preferences"]> {
  const defaultUpdateChannel = resolveDefaultDesktopUpdateChannel(options);
  try {
    const response = await options.tuttidClient.getDesktopPreferences();
    if (response.initialized) {
      const shouldMigrateDefaultUpdateChannel =
        await shouldMigrateDefaultDesktopUpdateChannel(options);
      const migratedPreferences = await migrateInitializedDesktopPreferences(
        options,
        response.preferences,
        defaultUpdateChannel,
        shouldMigrateDefaultUpdateChannel
      );
      return alignUpdateChannelWithInstalledVersion(
        options,
        migratedPreferences
      );
    }

    const initializedPreferences = (
      await options.tuttidClient.putDesktopPreferences({
        preferences: {
          agentComposerDefaultsByProvider: {},
          agentGuiConversationRailCollapsedByProvider: {},
          agentConversationDetailMode:
            defaultDesktopAgentConversationDetailMode,
          // The dual-dock (legacySplit) layout has been removed; the stored
          // preference is pinned to the unified layout.
          agentDockLayout: "unified",
          appCatalogChannel: defaultDesktopAppCatalogChannel,
          browserUseConnectionMode: defaultDesktopBrowserUseConnectionMode,
          defaultAgentProvider: defaultDesktopAgentProvider,
          dockIconStyle: defaultDesktopDockIconStyle,
          dockPlacement: defaultDesktopDockPlacement,
          deletedAgentConversationRetentionDays:
            defaultDeletedAgentConversationRetentionDays,
          featureFlags: defaultDesktopFeatureFlags,
          fileDefaultOpenersByExtension:
            defaultDesktopFileDefaultOpenersByExtension,
          locale: options.fallbackLocale,
          minimizeAnimation: defaultDesktopMinimizeAnimation,
          showAppDeveloperSources: defaultDesktopShowAppDeveloperSources,
          sleepPreventionMode: defaultDesktopSleepPreventionMode,
          themeSource: defaultDesktopThemeSource,
          updateChannel: defaultUpdateChannel,
          updatePolicy: defaultDesktopUpdatePolicy,
          workbenchShortcuts: defaultDesktopWorkbenchShortcuts
        }
      })
    ).preferences;
    return alignUpdateChannelWithInstalledVersion(
      options,
      initializedPreferences
    );
  } catch (error) {
    options.logger.warn("failed to resolve desktop preferences from tuttid", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      agentComposerDefaultsByProvider: {},
      agentGuiConversationRailCollapsedByProvider: {},
      agentConversationDetailMode: defaultDesktopAgentConversationDetailMode,
      agentDockLayout: "unified",
      appCatalogChannel: defaultDesktopAppCatalogChannel,
      browserUseConnectionMode: defaultDesktopBrowserUseConnectionMode,
      defaultAgentProvider: defaultDesktopAgentProvider,
      dockIconStyle: defaultDesktopDockIconStyle,
      dockPlacement: defaultDesktopDockPlacement,
      deletedAgentConversationRetentionDays:
        defaultDeletedAgentConversationRetentionDays,
      featureFlags: defaultDesktopFeatureFlags,
      fileDefaultOpenersByExtension:
        defaultDesktopFileDefaultOpenersByExtension,
      locale: options.fallbackLocale,
      minimizeAnimation: defaultDesktopMinimizeAnimation,
      showAppDeveloperSources: defaultDesktopShowAppDeveloperSources,
      sleepPreventionMode: defaultDesktopSleepPreventionMode,
      themeSource: defaultDesktopThemeSource,
      updateChannel: defaultUpdateChannel,
      updatePolicy: defaultDesktopUpdatePolicy,
      workbenchShortcuts: defaultDesktopWorkbenchShortcuts
    };
  }
}

async function alignUpdateChannelWithInstalledVersion(
  options: CreateDesktopHostPreferencesOptions,
  preferences: PutDesktopPreferencesRequest["preferences"]
): Promise<PutDesktopPreferencesRequest["preferences"]> {
  const installedVersion = resolveInstalledDesktopVersion(options);
  if (!options.isPackaged || !installedVersion) {
    return preferences;
  }

  const statePath = resolveUpdateChannelInstalledVersionStatePath(options);
  if ((await readInstalledDesktopVersion(statePath)) === installedVersion) {
    return preferences;
  }

  const installedChannel = resolveDefaultDesktopUpdateChannel(options);
  let alignedPreferences = preferences;
  if (preferences.updateChannel !== installedChannel) {
    try {
      alignedPreferences = (
        await options.tuttidClient.putDesktopPreferences({
          preferences: {
            ...preferences,
            updateChannel: installedChannel
          }
        })
      ).preferences;
      options.logger.info(
        "desktop update channel aligned with installed version",
        {
          app_version: installedVersion,
          previous_channel: preferences.updateChannel,
          update_channel: installedChannel
        }
      );
    } catch (error) {
      options.logger.warn(
        "failed to align desktop update channel with installed version",
        {
          app_version: installedVersion,
          error: error instanceof Error ? error.message : String(error),
          update_channel: installedChannel
        }
      );
      return preferences;
    }
  }

  try {
    await writeInstalledDesktopVersion(statePath, installedVersion);
  } catch (error) {
    options.logger.warn("failed to record installed desktop version", {
      app_version: installedVersion,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  return alignedPreferences;
}

async function migrateInitializedDesktopPreferences(
  options: CreateDesktopHostPreferencesOptions,
  preferences: PutDesktopPreferencesRequest["preferences"],
  defaultUpdateChannel: DesktopUpdateChannel,
  shouldMigrateDefaultUpdateChannel: boolean
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
  // The dual-dock (legacySplit) layout has been removed; stored preferences
  // are pinned to the unified layout.
  const normalizedAgentDockLayout = "unified" as const;
  const normalizedFeatureFlags = normalizeDesktopFeatureFlags(
    preferences.featureFlags
  );
  const normalizedWorkbenchShortcuts = normalizeDesktopWorkbenchShortcuts(
    preferences.workbenchShortcuts
  );
  if (
    !shouldMigrateDefaultUpdateChannel ||
    preferences.updateChannel !== "rc" ||
    defaultUpdateChannel !== "stable"
  ) {
    if (
      preferences.minimizeAnimation === normalizedMinimizeAnimation &&
      preferences.agentConversationDetailMode ===
        normalizedAgentConversationDetailMode &&
      preferences.agentDockLayout === normalizedAgentDockLayout
    ) {
      return {
        ...preferences,
        featureFlags: normalizedFeatureFlags,
        workbenchShortcuts: normalizedWorkbenchShortcuts
      };
    }
    return {
      ...preferences,
      agentConversationDetailMode: normalizedAgentConversationDetailMode,
      agentDockLayout: normalizedAgentDockLayout,
      featureFlags: normalizedFeatureFlags,
      minimizeAnimation: normalizedMinimizeAnimation,
      workbenchShortcuts: normalizedWorkbenchShortcuts
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
      return {
        ...preferences,
        featureFlags: normalizedFeatureFlags,
        workbenchShortcuts: normalizedWorkbenchShortcuts
      };
    }
    return {
      ...preferences,
      agentConversationDetailMode: normalizedAgentConversationDetailMode,
      agentDockLayout: normalizedAgentDockLayout,
      featureFlags: normalizedFeatureFlags,
      minimizeAnimation: normalizedMinimizeAnimation,
      workbenchShortcuts: normalizedWorkbenchShortcuts
    };
  }

  try {
    const response = await options.tuttidClient.putDesktopPreferences({
      preferences: {
        ...preferences,
        agentConversationDetailMode: normalizedAgentConversationDetailMode,
        agentDockLayout: normalizedAgentDockLayout,
        featureFlags: normalizedFeatureFlags,
        minimizeAnimation: normalizedMinimizeAnimation,
        updateChannel: defaultUpdateChannel,
        workbenchShortcuts: normalizedWorkbenchShortcuts
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
      featureFlags: normalizedFeatureFlags,
      minimizeAnimation: normalizedMinimizeAnimation,
      workbenchShortcuts: normalizedWorkbenchShortcuts
    };
  }
}

async function shouldMigrateDefaultDesktopUpdateChannel(
  options: CreateDesktopHostPreferencesOptions
): Promise<boolean> {
  const installedVersion = resolveInstalledDesktopVersion(options);
  if (!options.isPackaged || !installedVersion) {
    return true;
  }

  const statePath = resolveUpdateChannelInstalledVersionStatePath(options);
  return (await readInstalledDesktopVersion(statePath)) !== installedVersion;
}

function resolveDefaultDesktopUpdateChannel(
  options: CreateDesktopHostPreferencesOptions
): DesktopUpdateChannel {
  const version = resolveInstalledDesktopVersion(options) ?? "";
  if (/^\d+\.\d+\.\d+-rc\.\d+$/u.test(version)) {
    return "rc";
  }

  return defaultDesktopUpdateChannel;
}

function resolveInstalledDesktopVersion(
  options: CreateDesktopHostPreferencesOptions
): string | null {
  const version = options.appVersion?.trim().replace(/^v/iu, "") ?? "";
  return version.length > 0 ? version : null;
}

function resolveUpdateChannelDefaultMigrationMarkerPath(
  options: CreateDesktopHostPreferencesOptions
): string {
  const stateRootDir = resolveDesktopPreferencesStateRootDir(options);
  return join(stateRootDir, "migrations", updateChannelDefaultMigrationID);
}

function resolveUpdateChannelInstalledVersionStatePath(
  options: CreateDesktopHostPreferencesOptions
): string {
  const stateRootDir = resolveDesktopPreferencesStateRootDir(options);
  return join(stateRootDir, "migrations", updateChannelInstalledVersionStateID);
}

function resolveDesktopPreferencesStateRootDir(
  options: CreateDesktopHostPreferencesOptions
): string {
  return (
    options.migrationStateRootDir ??
    resolveDesktopDefaultsFromEnv().state.rootDir
  );
}

async function readInstalledDesktopVersion(
  path: string
): Promise<string | null> {
  try {
    const version = (await readFile(path, "utf8")).trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

async function writeInstalledDesktopVersion(
  path: string,
  version: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, version, "utf8");
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
