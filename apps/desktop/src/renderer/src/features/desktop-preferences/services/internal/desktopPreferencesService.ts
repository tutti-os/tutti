import type { DesktopLocale } from "@shared/i18n";
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";
import type { IDesktopPreferencesService } from "../desktopPreferencesService.interface.ts";
import type { DesktopPreferencesClient } from "./adapters/desktopPreferencesClient.ts";
import { createDesktopPreferencesStore } from "./desktopPreferencesStore.ts";
import {
  desktopAgentComposerDefaultsByProviderEqual,
  defaultDesktopAgentProvider,
  defaultDesktopDockIconStyle,
  defaultDesktopDockPlacement,
  defaultDesktopSleepPreventionMode,
  defaultDesktopUpdateChannel,
  defaultDesktopUpdatePolicy,
  mergeDesktopAgentComposerDefaultsByProvider,
  normalizeDesktopAgentComposerDefaults,
  normalizeDesktopAgentComposerDefaultsByProvider,
  type DesktopAgentComposerDefaults,
  type DesktopAgentComposerDefaultsByProvider,
  type DesktopAgentProvider,
  type DesktopDockIconStyle,
  type DesktopDockPlacement,
  type DesktopSleepPreventionMode,
  type DesktopUpdateChannel,
  type DesktopUpdatePolicy
} from "../../../../../../shared/preferences/index.ts";

export interface DesktopPreferencesServiceDependencies {
  applyLocale: (locale: DesktopLocale) => void;
  applyTheme: (theme: DesktopThemeState) => void;
  client: DesktopPreferencesClient;
  initialDockPlacement?: DesktopDockPlacement;
  initialLocale: DesktopLocale;
  initialTheme: DesktopThemeState;
  resolveTheme: (source: DesktopThemeSource) => DesktopThemeState;
}

export class DesktopPreferencesService implements IDesktopPreferencesService {
  readonly _serviceBrand: undefined;
  readonly store;

  private readonly dependencies: DesktopPreferencesServiceDependencies;
  private readonly unsubscribePreferencesUpdates: () => void;
  private disposed = false;

  constructor(dependencies: DesktopPreferencesServiceDependencies) {
    this.dependencies = dependencies;
    this.store = createDesktopPreferencesStore({
      agentComposerDefaultsByProvider: {},
      defaultAgentProvider: defaultDesktopAgentProvider,
      dockIconStyle: defaultDesktopDockIconStyle,
      dockPlacement:
        this.dependencies.initialDockPlacement ?? defaultDesktopDockPlacement,
      locale: this.dependencies.initialLocale,
      sleepPreventionMode: defaultDesktopSleepPreventionMode,
      theme: this.dependencies.initialTheme,
      updateChannel: defaultDesktopUpdateChannel,
      updatePolicy: defaultDesktopUpdatePolicy
    });
    this.unsubscribePreferencesUpdates =
      this.dependencies.client.subscribeToDesktopPreferencesUpdated(
        (preferences) => {
          this.applyPreferences(preferences);
        }
      );
    void this.initialize();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribePreferencesUpdates();
    this.dependencies.client.dispose();
  }

  async setDefaultAgentProvider(
    provider: DesktopAgentProvider
  ): Promise<DesktopAgentProvider> {
    if (this.store.changingDefaultAgentProvider === provider) {
      return provider;
    }

    const previousProvider = this.store.defaultAgentProvider;
    this.store.changingDefaultAgentProvider = provider;
    this.store.defaultAgentProvider = provider;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            defaultAgentProvider: provider
          })
        });
      return authoritativePreferences.defaultAgentProvider;
    } catch (error) {
      this.store.defaultAgentProvider = previousProvider;
      throw error;
    } finally {
      if (this.store.changingDefaultAgentProvider === provider) {
        this.store.changingDefaultAgentProvider = null;
      }
    }
  }

  async setDockPlacement(
    placement: DesktopDockPlacement
  ): Promise<DesktopDockPlacement> {
    if (this.store.changingDockPlacement === placement) {
      return placement;
    }

    const previousPlacement = this.store.dockPlacement;
    this.store.changingDockPlacement = placement;
    this.store.dockPlacement = placement;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            dockPlacement: placement
          })
        });
      return authoritativePreferences.dockPlacement;
    } catch (error) {
      this.store.dockPlacement = previousPlacement;
      throw error;
    } finally {
      if (this.store.changingDockPlacement === placement) {
        this.store.changingDockPlacement = null;
      }
    }
  }

  async setDockIconStyle(
    style: DesktopDockIconStyle
  ): Promise<DesktopDockIconStyle> {
    if (this.store.changingDockIconStyle === style) {
      return style;
    }

    const previousStyle = this.store.dockIconStyle;
    this.store.changingDockIconStyle = style;
    this.store.dockIconStyle = style;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            dockIconStyle: style
          })
        });
      return authoritativePreferences.dockIconStyle;
    } catch (error) {
      this.store.dockIconStyle = previousStyle;
      throw error;
    } finally {
      if (this.store.changingDockIconStyle === style) {
        this.store.changingDockIconStyle = null;
      }
    }
  }

  async setLocale(locale: DesktopLocale): Promise<DesktopLocale> {
    if (this.store.changingLocale === locale) {
      return locale;
    }

    const previousLocale = this.store.locale;
    this.store.changingLocale = locale;
    this.applyLocale(locale);
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({ locale })
        });
      return authoritativePreferences.locale;
    } catch (error) {
      this.applyLocale(previousLocale);
      throw error;
    } finally {
      if (this.store.changingLocale === locale) {
        this.store.changingLocale = null;
      }
    }
  }

  async setThemeSource(source: DesktopThemeSource): Promise<DesktopThemeState> {
    if (this.store.changingThemeSource === source) {
      return this.store.theme;
    }

    const previousTheme = this.store.theme;
    const nextTheme = this.dependencies.resolveTheme(source);
    this.store.changingThemeSource = source;
    this.applyTheme(nextTheme);
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({ themeSource: source })
        });
      return this.dependencies.resolveTheme(
        authoritativePreferences.themeSource
      );
    } catch (error) {
      this.applyTheme(previousTheme);
      throw error;
    } finally {
      if (this.store.changingThemeSource === source) {
        this.store.changingThemeSource = null;
      }
    }
  }

  async setSleepPreventionMode(
    mode: DesktopSleepPreventionMode
  ): Promise<DesktopSleepPreventionMode> {
    if (this.store.changingSleepPreventionMode === mode) {
      return mode;
    }

    const previousMode = this.store.sleepPreventionMode;
    this.store.changingSleepPreventionMode = mode;
    this.store.sleepPreventionMode = mode;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            sleepPreventionMode: mode
          })
        });
      return authoritativePreferences.sleepPreventionMode;
    } catch (error) {
      this.store.sleepPreventionMode = previousMode;
      throw error;
    } finally {
      if (this.store.changingSleepPreventionMode === mode) {
        this.store.changingSleepPreventionMode = null;
      }
    }
  }

  async setUpdatePolicy(
    policy: DesktopUpdatePolicy
  ): Promise<DesktopUpdatePolicy> {
    if (this.store.changingUpdatePolicy === policy) {
      return policy;
    }

    const previousPolicy = this.store.updatePolicy;
    this.store.changingUpdatePolicy = policy;
    this.store.updatePolicy = policy;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            updatePolicy: policy
          })
        });
      return authoritativePreferences.updatePolicy;
    } catch (error) {
      this.store.updatePolicy = previousPolicy;
      throw error;
    } finally {
      if (this.store.changingUpdatePolicy === policy) {
        this.store.changingUpdatePolicy = null;
      }
    }
  }

  async setUpdateChannel(
    channel: DesktopUpdateChannel
  ): Promise<DesktopUpdateChannel> {
    if (this.store.changingUpdateChannel === channel) {
      return channel;
    }

    const previousChannel = this.store.updateChannel;
    this.store.changingUpdateChannel = channel;
    this.store.updateChannel = channel;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            updateChannel: channel
          })
        });
      return authoritativePreferences.updateChannel;
    } catch (error) {
      this.store.updateChannel = previousChannel;
      throw error;
    } finally {
      if (this.store.changingUpdateChannel === channel) {
        this.store.changingUpdateChannel = null;
      }
    }
  }

  async rememberAgentComposerDefaults(
    provider: DesktopAgentProvider,
    defaults: DesktopAgentComposerDefaults | null
  ): Promise<void> {
    const previousDefaultsByProvider =
      this.store.agentComposerDefaultsByProvider;
    const nextDefaultsByProvider = mergeDesktopAgentComposerDefaultsByProvider(
      previousDefaultsByProvider,
      provider,
      normalizeDesktopAgentComposerDefaults(defaults)
    );
    if (
      desktopAgentComposerDefaultsByProviderEqual(
        previousDefaultsByProvider,
        nextDefaultsByProvider
      )
    ) {
      return;
    }

    this.store.agentComposerDefaultsByProvider = nextDefaultsByProvider;
    try {
      await this.dependencies.client.updateDesktopPreferences({
        preferences: this.currentPreferences({
          agentComposerDefaultsByProvider: nextDefaultsByProvider
        })
      });
    } catch (error) {
      this.store.agentComposerDefaultsByProvider = previousDefaultsByProvider;
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    try {
      const preferences =
        await this.dependencies.client.getDesktopPreferences();
      if (!this.disposed && preferences.initialized) {
        this.applyPreferences(preferences.preferences);
      }
    } catch {
      // Keep the current in-memory defaults when initial preference hydration fails.
    }

    try {
      if (this.disposed) {
        return;
      }
      await this.dependencies.client.connect();
    } catch {
      // Keep the bootstrapped in-memory state when the event stream is unavailable.
    }
  }

  private applyLocale(locale: DesktopLocale): void {
    if (this.store.locale === locale) {
      return;
    }

    this.dependencies.applyLocale(locale);
    this.store.locale = locale;
  }

  private applyTheme(theme: DesktopThemeState): void {
    if (
      this.store.theme.appearance === theme.appearance &&
      this.store.theme.source === theme.source
    ) {
      return;
    }

    this.dependencies.applyTheme(theme);
    this.store.theme = theme;
  }

  private applyPreferences(preferences: {
    agentComposerDefaultsByProvider?: DesktopAgentComposerDefaultsByProvider;
    defaultAgentProvider: DesktopAgentProvider;
    dockIconStyle: DesktopDockIconStyle;
    dockPlacement: DesktopDockPlacement;
    locale: DesktopLocale;
    sleepPreventionMode: DesktopSleepPreventionMode;
    themeSource: DesktopThemeSource;
    updateChannel: DesktopUpdateChannel;
    updatePolicy: DesktopUpdatePolicy;
  }): void {
    this.store.agentComposerDefaultsByProvider =
      normalizeDesktopAgentComposerDefaultsByProvider(
        preferences.agentComposerDefaultsByProvider
      );
    this.store.defaultAgentProvider = preferences.defaultAgentProvider;
    this.store.dockIconStyle = preferences.dockIconStyle;
    this.store.dockPlacement = preferences.dockPlacement;
    this.applyLocale(preferences.locale);
    this.store.sleepPreventionMode = preferences.sleepPreventionMode;
    this.applyTheme(this.dependencies.resolveTheme(preferences.themeSource));
    this.store.updateChannel = preferences.updateChannel;
    this.store.updatePolicy = preferences.updatePolicy;
  }

  private currentPreferences(
    overrides: Partial<{
      agentComposerDefaultsByProvider: DesktopAgentComposerDefaultsByProvider;
      defaultAgentProvider: DesktopAgentProvider;
      dockIconStyle: DesktopDockIconStyle;
      dockPlacement: DesktopDockPlacement;
      locale: DesktopLocale;
      sleepPreventionMode: DesktopSleepPreventionMode;
      themeSource: DesktopThemeSource;
      updateChannel: DesktopUpdateChannel;
      updatePolicy: DesktopUpdatePolicy;
    }> = {}
  ): {
    agentComposerDefaultsByProvider: DesktopAgentComposerDefaultsByProvider;
    defaultAgentProvider: DesktopAgentProvider;
    dockIconStyle: DesktopDockIconStyle;
    dockPlacement: DesktopDockPlacement;
    locale: DesktopLocale;
    sleepPreventionMode: DesktopSleepPreventionMode;
    themeSource: DesktopThemeSource;
    updateChannel: DesktopUpdateChannel;
    updatePolicy: DesktopUpdatePolicy;
  } {
    return {
      agentComposerDefaultsByProvider:
        normalizeDesktopAgentComposerDefaultsByProvider(
          overrides.agentComposerDefaultsByProvider ??
            this.store.agentComposerDefaultsByProvider
        ),
      defaultAgentProvider:
        overrides.defaultAgentProvider ?? this.store.defaultAgentProvider,
      dockIconStyle: overrides.dockIconStyle ?? this.store.dockIconStyle,
      dockPlacement: overrides.dockPlacement ?? this.store.dockPlacement,
      locale: overrides.locale ?? this.store.locale,
      sleepPreventionMode:
        overrides.sleepPreventionMode ?? this.store.sleepPreventionMode,
      themeSource: overrides.themeSource ?? this.store.theme.source,
      updateChannel: overrides.updateChannel ?? this.store.updateChannel,
      updatePolicy: overrides.updatePolicy ?? this.store.updatePolicy
    };
  }
}
