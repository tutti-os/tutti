import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  TuttidClient,
  PutDesktopPreferencesRequest
} from "@tutti-os/client-tuttid-ts";
import {
  normalizeDesktopAgentComposerDefaultsByProvider,
  type DesktopAgentComposerDefaultsByProvider,
  defaultDesktopAgentProvider,
  defaultDesktopDockIconStyle,
  defaultDesktopDockPlacement,
  defaultDesktopSleepPreventionMode,
  defaultDesktopUpdateChannel,
  defaultDesktopUpdatePolicy,
  type DesktopAgentProvider,
  type DesktopDockIconStyle,
  type DesktopDockPlacement,
  type DesktopSleepPreventionMode,
  type DesktopUpdateChannel,
  type DesktopUpdatePolicy
} from "../shared/preferences/index.ts";
import {
  defaultDesktopThemeSource,
  type DesktopThemeSource
} from "../shared/theme/index.ts";
import type { DesktopLocale } from "../shared/i18n/index.ts";
import type { DesktopLogger } from "./logging.ts";
import { resolveDesktopDefaultsFromEnv } from "./defaults.ts";

const updateChannelDefaultMigrationID = "desktop-update-channel-default-rc-v1";

export interface DesktopHostPreferencesState {
  getAgentComposerDefaultsByProvider(): DesktopAgentComposerDefaultsByProvider;
  getDefaultAgentProvider(): DesktopAgentProvider;
  getDockIconStyle(): DesktopDockIconStyle;
  getDockPlacement(): DesktopDockPlacement;
  getLocale(): DesktopLocale;
  getSleepPreventionMode(): DesktopSleepPreventionMode;
  getThemeSource(): DesktopThemeSource;
  getUpdateChannel(): DesktopUpdateChannel;
  getUpdatePolicy(): DesktopUpdatePolicy;
  subscribe(listener: () => void): () => void;
  sync(input: {
    agentComposerDefaultsByProvider?: DesktopAgentComposerDefaultsByProvider;
    defaultAgentProvider?: DesktopAgentProvider;
    dockIconStyle?: DesktopDockIconStyle;
    dockPlacement?: DesktopDockPlacement;
    locale?: DesktopLocale;
    sleepPreventionMode?: DesktopSleepPreventionMode;
    themeSource?: DesktopThemeSource;
    updateChannel?: DesktopUpdateChannel;
    updatePolicy?: DesktopUpdatePolicy;
  }): void;
}

export interface CreateDesktopHostPreferencesOptions {
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
  let defaultAgentProvider = initialPreferences.defaultAgentProvider;
  let dockIconStyle = initialPreferences.dockIconStyle;
  let dockPlacement = initialPreferences.dockPlacement;
  let locale = initialPreferences.locale;
  let sleepPreventionMode = initialPreferences.sleepPreventionMode;
  let themeSource = initialPreferences.themeSource;
  let updateChannel = initialPreferences.updateChannel;
  let updatePolicy = initialPreferences.updatePolicy;
  const listeners = new Set<() => void>();

  return {
    getAgentComposerDefaultsByProvider() {
      return agentComposerDefaultsByProvider;
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
    getLocale() {
      return locale;
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
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sync(input) {
      const previousAgentComposerDefaultsByProvider =
        agentComposerDefaultsByProvider;
      const previousDefaultAgentProvider = defaultAgentProvider;
      const previousDockIconStyle = dockIconStyle;
      const previousDockPlacement = dockPlacement;
      const previousLocale = locale;
      const previousSleepPreventionMode = sleepPreventionMode;
      const previousThemeSource = themeSource;
      const previousUpdateChannel = updateChannel;
      const previousUpdatePolicy = updatePolicy;
      if (input.agentComposerDefaultsByProvider) {
        agentComposerDefaultsByProvider =
          normalizeDesktopAgentComposerDefaultsByProvider(
            input.agentComposerDefaultsByProvider
          );
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
      if (input.locale) {
        locale = input.locale;
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
      if (
        agentComposerDefaultsByProvider !==
          previousAgentComposerDefaultsByProvider ||
        defaultAgentProvider !== previousDefaultAgentProvider ||
        dockIconStyle !== previousDockIconStyle ||
        dockPlacement !== previousDockPlacement ||
        locale !== previousLocale ||
        sleepPreventionMode !== previousSleepPreventionMode ||
        themeSource !== previousThemeSource ||
        updateChannel !== previousUpdateChannel ||
        updatePolicy !== previousUpdatePolicy
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
  try {
    const response = await options.tuttidClient.getDesktopPreferences();
    if (response.initialized) {
      return migrateInitializedDesktopPreferences(
        options,
        response.preferences
      );
    }

    return (
      await options.tuttidClient.putDesktopPreferences({
        preferences: {
          agentComposerDefaultsByProvider: {},
          defaultAgentProvider: defaultDesktopAgentProvider,
          dockIconStyle: defaultDesktopDockIconStyle,
          dockPlacement: defaultDesktopDockPlacement,
          locale: options.fallbackLocale,
          sleepPreventionMode: defaultDesktopSleepPreventionMode,
          themeSource: defaultDesktopThemeSource,
          updateChannel: defaultDesktopUpdateChannel,
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
      defaultAgentProvider: defaultDesktopAgentProvider,
      dockIconStyle: defaultDesktopDockIconStyle,
      dockPlacement: defaultDesktopDockPlacement,
      locale: options.fallbackLocale,
      sleepPreventionMode: defaultDesktopSleepPreventionMode,
      themeSource: defaultDesktopThemeSource,
      updateChannel: defaultDesktopUpdateChannel,
      updatePolicy: defaultDesktopUpdatePolicy
    };
  }
}

async function migrateInitializedDesktopPreferences(
  options: CreateDesktopHostPreferencesOptions,
  preferences: PutDesktopPreferencesRequest["preferences"]
): Promise<PutDesktopPreferencesRequest["preferences"]> {
  if (
    preferences.updateChannel !== "stable" ||
    defaultDesktopUpdateChannel !== "rc"
  ) {
    return preferences;
  }

  const markerPath = resolveUpdateChannelDefaultMigrationMarkerPath(options);
  if (await hasMigrationMarker(markerPath)) {
    return preferences;
  }

  try {
    const response = await options.tuttidClient.putDesktopPreferences({
      preferences: {
        ...preferences,
        updateChannel: defaultDesktopUpdateChannel
      }
    });
    await writeMigrationMarker(markerPath);
    return response.preferences;
  } catch (error) {
    options.logger.warn("failed to migrate default desktop update channel", {
      error: error instanceof Error ? error.message : String(error)
    });
    return preferences;
  }
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
