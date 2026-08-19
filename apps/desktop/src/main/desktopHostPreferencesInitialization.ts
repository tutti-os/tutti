import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DesktopPreferencesStateResponse,
  PutDesktopPreferencesRequest,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import {
  defaultDesktopAgentCliUpdateCheckEnabled,
  defaultDesktopAgentConversationDetailMode,
  defaultDesktopAgentProvider,
  defaultDesktopAppCatalogChannel,
  defaultDesktopBrowserUseConnectionMode,
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
  isDesktopMinimizeAnimation,
  normalizeDesktopAgentConversationDetailMode,
  normalizeDesktopFeatureFlags,
  normalizeDesktopWorkbenchShortcuts,
  type DesktopUpdateChannel
} from "../shared/preferences/index.ts";
import { defaultDesktopThemeSource } from "../shared/theme/index.ts";
import type { DesktopLocale } from "../shared/i18n/index.ts";
import { resolveDesktopDefaultsFromEnv } from "./defaults.ts";
import type { DesktopLogger } from "./logging.ts";

const updateChannelDefaultMigrationID =
  "desktop-update-channel-default-stable-v1";
const updateChannelInstalledVersionStateID =
  "desktop-update-channel-installed-version-v1";

type DesktopPreferences = PutDesktopPreferencesRequest["preferences"];
type InitializationStatus = "initialized" | "missing" | "unknown";

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

export interface DesktopHostPreferencesInitialization {
  initialPreferences: DesktopPreferences;
  ensureInitialized(): Promise<DesktopPreferencesStateResponse>;
  observeAuthoritativePreferences(preferences: DesktopPreferences): void;
}

export async function createDesktopHostPreferencesInitialization(
  options: CreateDesktopHostPreferencesOptions
): Promise<DesktopHostPreferencesInitialization> {
  const defaultUpdateChannel = resolveDefaultDesktopUpdateChannel(options);
  let status: InitializationStatus = "unknown";
  let authoritativePreferences: DesktopPreferences | null = null;
  let initializationCandidate: DesktopPreferences | null = null;
  let ensurePromise: Promise<DesktopPreferencesStateResponse> | null = null;

  const initialPreferences = await resolveInitialPreferences();

  return {
    initialPreferences,
    ensureInitialized() {
      if (status === "initialized" && authoritativePreferences) {
        return Promise.resolve({
          initialized: true,
          preferences: authoritativePreferences
        });
      }
      if (ensurePromise) {
        return ensurePromise;
      }

      ensurePromise = ensureDurablePreferences().finally(() => {
        ensurePromise = null;
      });
      return ensurePromise;
    },
    observeAuthoritativePreferences(preferences) {
      status = "initialized";
      authoritativePreferences = preferences;
      initializationCandidate = null;
    }
  };

  async function resolveInitialPreferences(): Promise<DesktopPreferences> {
    let response: DesktopPreferencesStateResponse;
    try {
      response = await options.tuttidClient.getDesktopPreferences();
    } catch (error) {
      options.logger.warn("failed to read desktop preferences from tuttid", {
        error: error instanceof Error ? error.message : String(error)
      });
      status = "unknown";
      return createLegacyFallbackDesktopPreferences(
        options,
        defaultUpdateChannel
      );
    }

    if (response.initialized) {
      return await adoptDurablePreferences(response.preferences);
    }

    status = "missing";
    initializationCandidate = createFreshDesktopPreferences(
      options,
      response.preferences,
      defaultUpdateChannel
    );
    const initialized = await tryInitialize(initializationCandidate);
    if (initialized) {
      return initialized.preferences;
    }

    // The read proved that this identity had no stored preferences. Keep the
    // fresh Agent default in memory, but do not run durable migrations or
    // write local markers until the row is confirmed persisted.
    return initializationCandidate;
  }

  async function ensureDurablePreferences(): Promise<DesktopPreferencesStateResponse> {
    let current: DesktopPreferencesStateResponse;
    try {
      current = await options.tuttidClient.getDesktopPreferences();
    } catch (error) {
      options.logger.warn(
        "failed to recover desktop preferences before mutation",
        {
          error: error instanceof Error ? error.message : String(error)
        }
      );
      throw error;
    }

    if (current.initialized) {
      const preferences = await adoptDurablePreferences(current.preferences);
      return { initialized: true, preferences };
    }

    status = "missing";
    initializationCandidate = createFreshDesktopPreferences(
      options,
      current.preferences,
      defaultUpdateChannel
    );
    const initialized = await tryInitialize(initializationCandidate, true);
    if (initialized) {
      return initialized;
    }

    throw new Error(
      "Desktop preferences could not be initialized before mutation."
    );
  }

  async function tryInitialize(
    candidate: DesktopPreferences,
    rethrowFailure = false
  ): Promise<DesktopPreferencesStateResponse | null> {
    let initializationError: unknown;
    try {
      const initialized = await options.tuttidClient.putDesktopPreferences({
        writeMode: "initializeIfAbsent",
        preferences: candidate
      });
      if (initialized.initialized) {
        const preferences = await adoptDurablePreferences(
          initialized.preferences
        );
        return { initialized: true, preferences };
      }
      initializationError = new Error(
        "Desktop preference initialization returned an uninitialized state."
      );
    } catch (error) {
      initializationError = error;
      options.logger.warn(
        "failed to initialize desktop preferences in tuttid",
        {
          error: error instanceof Error ? error.message : String(error)
        }
      );
    }

    try {
      const reconciled = await options.tuttidClient.getDesktopPreferences();
      if (reconciled.initialized) {
        const preferences = await adoptDurablePreferences(
          reconciled.preferences
        );
        return { initialized: true, preferences };
      }
    } catch (error) {
      options.logger.warn(
        "failed to reconcile desktop preferences after initialization",
        {
          error: error instanceof Error ? error.message : String(error)
        }
      );
    }

    status = "missing";
    authoritativePreferences = null;
    if (rethrowFailure && initializationError) {
      throw initializationError;
    }
    return null;
  }

  async function adoptDurablePreferences(
    preferences: DesktopPreferences
  ): Promise<DesktopPreferences> {
    const shouldMigrateDefaultUpdateChannel =
      await shouldMigrateDefaultDesktopUpdateChannel(options);
    const migratedPreferences = await migrateInitializedDesktopPreferences(
      options,
      preferences,
      defaultUpdateChannel,
      shouldMigrateDefaultUpdateChannel
    );
    const alignedPreferences = await alignUpdateChannelWithInstalledVersion(
      options,
      migratedPreferences
    );
    status = "initialized";
    authoritativePreferences = alignedPreferences;
    initializationCandidate = null;
    return alignedPreferences;
  }
}

function createFreshDesktopPreferences(
  options: CreateDesktopHostPreferencesOptions,
  daemonDefaults: DesktopPreferences,
  updateChannel: DesktopUpdateChannel
): DesktopPreferences {
  return {
    ...daemonDefaults,
    // These values depend on the desktop runtime rather than daemon policy.
    agentDockLayout: "unified",
    featureFlags: normalizeDesktopFeatureFlags(daemonDefaults.featureFlags),
    locale: options.fallbackLocale,
    minimizeAnimation: defaultDesktopMinimizeAnimation,
    updateChannel
  };
}

function createLegacyFallbackDesktopPreferences(
  options: CreateDesktopHostPreferencesOptions,
  updateChannel: DesktopUpdateChannel
): DesktopPreferences {
  return {
    agentCliUpdateCheckEnabled: defaultDesktopAgentCliUpdateCheckEnabled,
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
    fileDefaultOpenersByExtension: defaultDesktopFileDefaultOpenersByExtension,
    locale: options.fallbackLocale,
    minimizeAnimation: defaultDesktopMinimizeAnimation,
    showAppDeveloperSources: defaultDesktopShowAppDeveloperSources,
    sleepPreventionMode: defaultDesktopSleepPreventionMode,
    themeSource: defaultDesktopThemeSource,
    updateChannel,
    updatePolicy: defaultDesktopUpdatePolicy,
    workbenchShortcuts: defaultDesktopWorkbenchShortcuts
  };
}

async function alignUpdateChannelWithInstalledVersion(
  options: CreateDesktopHostPreferencesOptions,
  preferences: DesktopPreferences
): Promise<DesktopPreferences> {
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
  preferences: DesktopPreferences,
  defaultUpdateChannel: DesktopUpdateChannel,
  shouldMigrateDefaultUpdateChannel: boolean
): Promise<DesktopPreferences> {
  const normalizedMinimizeAnimation = isDesktopMinimizeAnimation(
    preferences.minimizeAnimation
  )
    ? preferences.minimizeAnimation
    : defaultDesktopMinimizeAnimation;
  const normalizedAgentConversationDetailMode =
    normalizeDesktopAgentConversationDetailMode(
      preferences.agentConversationDetailMode
    );
  const normalizedAgentDockLayout = "unified" as const;
  const normalizedFeatureFlags = normalizeDesktopFeatureFlags(
    preferences.featureFlags
  );
  const normalizedWorkbenchShortcuts = normalizeDesktopWorkbenchShortcuts(
    preferences.workbenchShortcuts
  );
  const normalizedPreferences = {
    ...preferences,
    agentConversationDetailMode: normalizedAgentConversationDetailMode,
    agentDockLayout: normalizedAgentDockLayout,
    featureFlags: normalizedFeatureFlags,
    minimizeAnimation: normalizedMinimizeAnimation,
    workbenchShortcuts: normalizedWorkbenchShortcuts
  };
  if (
    !shouldMigrateDefaultUpdateChannel ||
    preferences.updateChannel !== "rc" ||
    defaultUpdateChannel !== "stable"
  ) {
    return normalizedPreferences;
  }

  const markerPath = resolveUpdateChannelDefaultMigrationMarkerPath(options);
  if (await hasMigrationMarker(markerPath)) {
    return normalizedPreferences;
  }

  try {
    const response = await options.tuttidClient.putDesktopPreferences({
      preferences: {
        ...normalizedPreferences,
        updateChannel: defaultUpdateChannel
      }
    });
    await writeMigrationMarker(markerPath);
    return response.preferences;
  } catch (error) {
    options.logger.warn("failed to migrate default desktop update channel", {
      error: error instanceof Error ? error.message : String(error)
    });
    return normalizedPreferences;
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
  return join(
    resolveDesktopPreferencesStateRootDir(options),
    "migrations",
    updateChannelDefaultMigrationID
  );
}

function resolveUpdateChannelInstalledVersionStatePath(
  options: CreateDesktopHostPreferencesOptions
): string {
  return join(
    resolveDesktopPreferencesStateRootDir(options),
    "migrations",
    updateChannelInstalledVersionStateID
  );
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
