import type { DesktopLocale } from "@shared/i18n";
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";
import type { IDesktopPreferencesService } from "../desktopPreferencesService.interface.ts";
import type { DesktopAgentComposerDefaultsPatchResult } from "../desktopPreferencesService.interface.ts";
import type { DesktopPreferencesClient } from "./adapters/desktopPreferencesClient.ts";
import { createDesktopPreferencesStore } from "./desktopPreferencesStore.ts";
import { AgentComposerDefaultsPatchCoordinator } from "./agentComposerDefaultsPatchCoordinator.ts";
import {
  desktopAgentGuiConversationRailCollapsedByProviderEqual,
  defaultDesktopAgentProvider,
  defaultDesktopAgentConversationDetailMode,
  defaultDesktopAppCatalogChannel,
  defaultDesktopBrowserUseConnectionMode,
  defaultDesktopDockIconStyle,
  defaultDesktopDockPlacement,
  defaultDesktopFeatureFlags,
  defaultDesktopFileDefaultOpenersByExtension,
  defaultDesktopMinimizeAnimation,
  defaultDesktopShowAppDeveloperSources,
  defaultDesktopSleepPreventionMode,
  defaultDesktopUpdateChannel,
  defaultDesktopUpdatePolicy,
  defaultDesktopWorkbenchShortcuts,
  defaultDesktopWorkbenchWindowSnapping,
  desktopFeatureFlagsEqual,
  mergeDesktopAgentGuiConversationRailCollapsedByProvider,
  normalizeDesktopAgentComposerDefaultsByAgentTarget,
  normalizeDesktopAgentConversationDetailMode,
  normalizeDesktopFeatureFlags,
  normalizeDesktopFileDefaultOpenersByExtension,
  normalizeDesktopAgentGuiConversationRailCollapsedByProvider,
  normalizeDesktopWorkbenchShortcuts,
  normalizeDesktopWorkbenchWindowSnapping,
  desktopFileDefaultOpenersByExtensionEqual,
  desktopWorkbenchShortcutsEqual,
  desktopWorkbenchWindowSnappingEqual,
  type DesktopAgentComposerDefaultsPatch,
  type DesktopAgentComposerDefaultsByAgentTarget,
  type DesktopAgentComposerDefaultsByProvider,
  type DesktopAgentGuiConversationRailCollapsedByProvider,
  type DesktopAgentProvider,
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
  private readonly agentComposerDefaultsPatchCoordinator: AgentComposerDefaultsPatchCoordinator;
  private readonly unsubscribePreferencesUpdates: () => void;
  private disposed = false;

  constructor(dependencies: DesktopPreferencesServiceDependencies) {
    this.dependencies = dependencies;
    this.agentComposerDefaultsPatchCoordinator =
      new AgentComposerDefaultsPatchCoordinator({
        publish: (input) =>
          this.dependencies.client.patchAgentComposerDefaultsForTarget(input)
      });
    this.store = createDesktopPreferencesStore({
      agentComposerDefaultsByProvider: {},
      agentComposerDefaultsByAgentTarget: {},
      agentGuiConversationRailCollapsedByProvider: {},
      agentConversationDetailMode: defaultDesktopAgentConversationDetailMode,
      appCatalogChannel: defaultDesktopAppCatalogChannel,
      browserUseConnectionMode: defaultDesktopBrowserUseConnectionMode,
      defaultAgentProvider: defaultDesktopAgentProvider,
      dockIconStyle: defaultDesktopDockIconStyle,
      dockPlacement:
        this.dependencies.initialDockPlacement ?? defaultDesktopDockPlacement,
      featureFlags: defaultDesktopFeatureFlags,
      fileDefaultOpenersByExtension:
        defaultDesktopFileDefaultOpenersByExtension,
      locale: this.dependencies.initialLocale,
      minimizeAnimation: defaultDesktopMinimizeAnimation,
      sleepPreventionMode: defaultDesktopSleepPreventionMode,
      showAppDeveloperSources: defaultDesktopShowAppDeveloperSources,
      theme: this.dependencies.initialTheme,
      updateChannel: defaultDesktopUpdateChannel,
      updatePolicy: defaultDesktopUpdatePolicy,
      workbenchShortcuts: defaultDesktopWorkbenchShortcuts,
      workbenchWindowSnapping: defaultDesktopWorkbenchWindowSnapping
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
    this.agentComposerDefaultsPatchCoordinator.dispose();
    this.unsubscribePreferencesUpdates();
    this.dependencies.client.dispose();
  }

  async setDefaultAgentProvider(
    provider: DesktopDefaultAgentProvider
  ): Promise<DesktopDefaultAgentProvider> {
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

  async setAgentConversationDetailMode(
    mode: DesktopAgentConversationDetailMode
  ): Promise<DesktopAgentConversationDetailMode> {
    const nextMode = normalizeDesktopAgentConversationDetailMode(mode);
    if (this.store.changingAgentConversationDetailMode === nextMode) {
      return nextMode;
    }

    const previousMode = this.store.agentConversationDetailMode;
    this.store.changingAgentConversationDetailMode = nextMode;
    this.store.agentConversationDetailMode = nextMode;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            agentConversationDetailMode: nextMode
          })
        });
      return normalizeDesktopAgentConversationDetailMode(
        authoritativePreferences.agentConversationDetailMode
      );
    } catch (error) {
      this.store.agentConversationDetailMode = previousMode;
      throw error;
    } finally {
      if (this.store.changingAgentConversationDetailMode === nextMode) {
        this.store.changingAgentConversationDetailMode = null;
      }
    }
  }

  async setAppCatalogChannel(
    channel: DesktopAppCatalogChannel
  ): Promise<DesktopAppCatalogChannel> {
    if (this.store.changingAppCatalogChannel === channel) {
      return channel;
    }

    const previousChannel = this.store.appCatalogChannel;
    this.store.changingAppCatalogChannel = channel;
    this.store.appCatalogChannel = channel;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            appCatalogChannel: channel
          })
        });
      return authoritativePreferences.appCatalogChannel;
    } catch (error) {
      this.store.appCatalogChannel = previousChannel;
      throw error;
    } finally {
      if (this.store.changingAppCatalogChannel === channel) {
        this.store.changingAppCatalogChannel = null;
      }
    }
  }

  async setBrowserUseConnectionMode(
    mode: DesktopBrowserUseConnectionMode
  ): Promise<DesktopBrowserUseConnectionMode> {
    if (this.store.changingBrowserUseConnectionMode === mode) {
      return mode;
    }

    const previousMode = this.store.browserUseConnectionMode;
    this.store.changingBrowserUseConnectionMode = mode;
    this.store.browserUseConnectionMode = mode;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            browserUseConnectionMode: mode
          })
        });
      return (
        authoritativePreferences.browserUseConnectionMode ??
        defaultDesktopBrowserUseConnectionMode
      );
    } catch (error) {
      this.store.browserUseConnectionMode = previousMode;
      throw error;
    } finally {
      if (this.store.changingBrowserUseConnectionMode === mode) {
        this.store.changingBrowserUseConnectionMode = null;
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

  async setFileDefaultOpenersByExtension(
    openersByExtension: DesktopFileDefaultOpenersByExtension
  ): Promise<DesktopFileDefaultOpenersByExtension> {
    const nextOpenersByExtension =
      normalizeDesktopFileDefaultOpenersByExtension(openersByExtension);
    if (
      desktopFileDefaultOpenersByExtensionEqual(
        this.store.fileDefaultOpenersByExtension,
        nextOpenersByExtension
      )
    ) {
      return this.store.fileDefaultOpenersByExtension;
    }

    const previousOpenersByExtension = this.store.fileDefaultOpenersByExtension;
    this.store.fileDefaultOpenersByExtension = nextOpenersByExtension;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            fileDefaultOpenersByExtension: nextOpenersByExtension
          })
        });
      return normalizeDesktopFileDefaultOpenersByExtension(
        authoritativePreferences.fileDefaultOpenersByExtension
      );
    } catch (error) {
      this.store.fileDefaultOpenersByExtension = previousOpenersByExtension;
      throw error;
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

  async setFeatureFlags(
    flags: DesktopFeatureFlags
  ): Promise<DesktopFeatureFlags> {
    const nextFlags = normalizeDesktopFeatureFlags(flags);
    if (
      this.store.changingFeatureFlags &&
      desktopFeatureFlagsEqual(this.store.changingFeatureFlags, nextFlags)
    ) {
      return nextFlags;
    }
    if (desktopFeatureFlagsEqual(this.store.featureFlags, nextFlags)) {
      return this.store.featureFlags;
    }

    const previousFlags = this.store.featureFlags;
    this.store.changingFeatureFlags = nextFlags;
    this.store.featureFlags = nextFlags;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({ featureFlags: nextFlags })
        });
      return normalizeDesktopFeatureFlags(
        authoritativePreferences.featureFlags
      );
    } catch (error) {
      this.store.featureFlags = previousFlags;
      throw error;
    } finally {
      if (
        this.store.changingFeatureFlags &&
        desktopFeatureFlagsEqual(this.store.changingFeatureFlags, nextFlags)
      ) {
        this.store.changingFeatureFlags = null;
      }
    }
  }

  async setWorkbenchShortcuts(
    shortcuts: DesktopWorkbenchShortcuts
  ): Promise<DesktopWorkbenchShortcuts> {
    const nextShortcuts = normalizeDesktopWorkbenchShortcuts(shortcuts);
    if (
      desktopWorkbenchShortcutsEqual(
        this.store.workbenchShortcuts,
        nextShortcuts
      )
    ) {
      return this.store.workbenchShortcuts;
    }

    const previousShortcuts = this.store.workbenchShortcuts;
    this.store.workbenchShortcuts = nextShortcuts;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            workbenchShortcuts: nextShortcuts
          })
        });
      return normalizeDesktopWorkbenchShortcuts(
        authoritativePreferences.workbenchShortcuts
      );
    } catch (error) {
      this.store.workbenchShortcuts = previousShortcuts;
      throw error;
    }
  }

  async setMinimizeAnimation(
    animation: DesktopMinimizeAnimation
  ): Promise<DesktopMinimizeAnimation> {
    if (this.store.changingMinimizeAnimation === animation) {
      return animation;
    }

    const previousAnimation = this.store.minimizeAnimation;
    this.store.changingMinimizeAnimation = animation;
    this.store.minimizeAnimation = animation;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            minimizeAnimation: animation
          })
        });
      return (
        authoritativePreferences.minimizeAnimation ??
        defaultDesktopMinimizeAnimation
      );
    } catch (error) {
      this.store.minimizeAnimation = previousAnimation;
      throw error;
    } finally {
      if (this.store.changingMinimizeAnimation === animation) {
        this.store.changingMinimizeAnimation = null;
      }
    }
  }

  async setWorkbenchWindowSnapping(
    value: DesktopWorkbenchWindowSnapping
  ): Promise<DesktopWorkbenchWindowSnapping> {
    const nextValue = normalizeDesktopWorkbenchWindowSnapping(value);
    if (
      this.store.changingWorkbenchWindowSnapping &&
      desktopWorkbenchWindowSnappingEqual(
        this.store.changingWorkbenchWindowSnapping,
        nextValue
      )
    ) {
      return nextValue;
    }

    const previousValue = this.store.workbenchWindowSnapping;
    this.store.changingWorkbenchWindowSnapping = nextValue;
    this.store.workbenchWindowSnapping = nextValue;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            workbenchWindowSnapping: nextValue
          })
        });
      return normalizeDesktopWorkbenchWindowSnapping(
        authoritativePreferences.workbenchWindowSnapping
      );
    } catch (error) {
      this.store.workbenchWindowSnapping = previousValue;
      throw error;
    } finally {
      if (
        this.store.changingWorkbenchWindowSnapping &&
        desktopWorkbenchWindowSnappingEqual(
          this.store.changingWorkbenchWindowSnapping,
          nextValue
        )
      ) {
        this.store.changingWorkbenchWindowSnapping = null;
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

  async setShowAppDeveloperSources(show: boolean): Promise<boolean> {
    if (this.store.changingShowAppDeveloperSources === show) {
      return show;
    }

    const previousShow = this.store.showAppDeveloperSources;
    this.store.changingShowAppDeveloperSources = show;
    this.store.showAppDeveloperSources = show;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            showAppDeveloperSources: show
          })
        });
      return authoritativePreferences.showAppDeveloperSources ?? false;
    } catch (error) {
      this.store.showAppDeveloperSources = previousShow;
      throw error;
    } finally {
      if (this.store.changingShowAppDeveloperSources === show) {
        this.store.changingShowAppDeveloperSources = null;
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

  async rememberAgentComposerDefaultsForAgentTarget(
    agentTargetId: string,
    defaults: DesktopAgentComposerDefaultsPatch | null
  ): Promise<DesktopAgentComposerDefaultsPatchResult> {
    return this.agentComposerDefaultsPatchCoordinator.patch(
      agentTargetId,
      defaults
    );
  }

  async rememberAgentGuiConversationRailCollapsed(
    provider: DesktopAgentProvider,
    collapsed: boolean
  ): Promise<void> {
    const previousCollapsedByProvider =
      this.store.agentGuiConversationRailCollapsedByProvider;
    const nextCollapsedByProvider =
      mergeDesktopAgentGuiConversationRailCollapsedByProvider(
        previousCollapsedByProvider,
        provider,
        collapsed
      );
    if (
      desktopAgentGuiConversationRailCollapsedByProviderEqual(
        previousCollapsedByProvider,
        nextCollapsedByProvider
      )
    ) {
      return;
    }

    this.store.agentGuiConversationRailCollapsedByProvider =
      nextCollapsedByProvider;
    try {
      await this.dependencies.client.updateDesktopPreferences({
        preferences: this.currentPreferences({
          agentGuiConversationRailCollapsedByProvider: nextCollapsedByProvider
        })
      });
    } catch (error) {
      this.store.agentGuiConversationRailCollapsedByProvider =
        previousCollapsedByProvider;
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
    agentComposerDefaultsByAgentTarget?: DesktopAgentComposerDefaultsByAgentTarget;
    agentGuiConversationRailCollapsedByProvider?: DesktopAgentGuiConversationRailCollapsedByProvider;
    agentConversationDetailMode?: DesktopAgentConversationDetailMode;
    appCatalogChannel: DesktopAppCatalogChannel;
    browserUseConnectionMode?: DesktopBrowserUseConnectionMode;
    defaultAgentProvider: DesktopDefaultAgentProvider;
    dockIconStyle: DesktopDockIconStyle;
    dockPlacement: DesktopDockPlacement;
    featureFlags?: DesktopFeatureFlags;
    fileDefaultOpenersByExtension?: DesktopFileDefaultOpenersByExtension;
    locale: DesktopLocale;
    minimizeAnimation?: DesktopMinimizeAnimation;
    sleepPreventionMode: DesktopSleepPreventionMode;
    showAppDeveloperSources?: boolean;
    themeSource: DesktopThemeSource;
    updateChannel: DesktopUpdateChannel;
    updatePolicy: DesktopUpdatePolicy;
    workbenchShortcuts?: DesktopWorkbenchShortcuts;
    workbenchWindowSnapping?: DesktopWorkbenchWindowSnapping;
  }): void {
    this.store.agentComposerDefaultsByAgentTarget =
      normalizeDesktopAgentComposerDefaultsByAgentTarget(
        preferences.agentComposerDefaultsByAgentTarget
      );
    this.store.agentGuiConversationRailCollapsedByProvider =
      normalizeDesktopAgentGuiConversationRailCollapsedByProvider(
        preferences.agentGuiConversationRailCollapsedByProvider
      );
    this.store.agentConversationDetailMode =
      normalizeDesktopAgentConversationDetailMode(
        preferences.agentConversationDetailMode
      );
    this.store.appCatalogChannel =
      preferences.appCatalogChannel ?? defaultDesktopAppCatalogChannel;
    this.store.browserUseConnectionMode =
      preferences.browserUseConnectionMode ??
      defaultDesktopBrowserUseConnectionMode;
    this.store.defaultAgentProvider = preferences.defaultAgentProvider;
    this.store.dockIconStyle = preferences.dockIconStyle;
    this.store.dockPlacement = preferences.dockPlacement;
    this.store.fileDefaultOpenersByExtension =
      normalizeDesktopFileDefaultOpenersByExtension(
        preferences.fileDefaultOpenersByExtension
      );
    const nextFeatureFlags = normalizeDesktopFeatureFlags(
      preferences.featureFlags
    );
    if (!desktopFeatureFlagsEqual(this.store.featureFlags, nextFeatureFlags)) {
      this.store.featureFlags = nextFeatureFlags;
    }
    this.applyLocale(preferences.locale);
    this.store.minimizeAnimation =
      preferences.minimizeAnimation ?? defaultDesktopMinimizeAnimation;
    this.store.sleepPreventionMode = preferences.sleepPreventionMode;
    this.store.showAppDeveloperSources =
      preferences.showAppDeveloperSources ??
      defaultDesktopShowAppDeveloperSources;
    this.applyTheme(this.dependencies.resolveTheme(preferences.themeSource));
    this.store.updateChannel = preferences.updateChannel;
    this.store.updatePolicy = preferences.updatePolicy;
    const nextWorkbenchShortcuts = normalizeDesktopWorkbenchShortcuts(
      preferences.workbenchShortcuts
    );
    if (
      !desktopWorkbenchShortcutsEqual(
        this.store.workbenchShortcuts,
        nextWorkbenchShortcuts
      )
    ) {
      this.store.workbenchShortcuts = nextWorkbenchShortcuts;
    }
    this.store.workbenchWindowSnapping =
      normalizeDesktopWorkbenchWindowSnapping(
        preferences.workbenchWindowSnapping
      );
  }

  private currentPreferences(
    overrides: Partial<{
      agentGuiConversationRailCollapsedByProvider: DesktopAgentGuiConversationRailCollapsedByProvider;
      agentConversationDetailMode: DesktopAgentConversationDetailMode;
      appCatalogChannel: DesktopAppCatalogChannel;
      browserUseConnectionMode: DesktopBrowserUseConnectionMode;
      defaultAgentProvider: DesktopDefaultAgentProvider;
      dockIconStyle: DesktopDockIconStyle;
      dockPlacement: DesktopDockPlacement;
      featureFlags: DesktopFeatureFlags;
      fileDefaultOpenersByExtension: DesktopFileDefaultOpenersByExtension;
      locale: DesktopLocale;
      minimizeAnimation: DesktopMinimizeAnimation;
      sleepPreventionMode: DesktopSleepPreventionMode;
      showAppDeveloperSources: boolean;
      themeSource: DesktopThemeSource;
      updateChannel: DesktopUpdateChannel;
      updatePolicy: DesktopUpdatePolicy;
      workbenchShortcuts: DesktopWorkbenchShortcuts;
      workbenchWindowSnapping: DesktopWorkbenchWindowSnapping;
    }> = {}
  ): {
    agentComposerDefaultsByProvider: DesktopAgentComposerDefaultsByProvider;
    agentComposerDefaultsByAgentTarget?: DesktopAgentComposerDefaultsByAgentTarget;
    agentGuiConversationRailCollapsedByProvider: DesktopAgentGuiConversationRailCollapsedByProvider;
    agentConversationDetailMode: DesktopAgentConversationDetailMode;
    agentDockLayout: "unified";
    appCatalogChannel: DesktopAppCatalogChannel;
    browserUseConnectionMode: DesktopBrowserUseConnectionMode;
    defaultAgentProvider: DesktopDefaultAgentProvider;
    dockIconStyle: DesktopDockIconStyle;
    dockPlacement: DesktopDockPlacement;
    featureFlags: DesktopFeatureFlags;
    fileDefaultOpenersByExtension: DesktopFileDefaultOpenersByExtension;
    locale: DesktopLocale;
    minimizeAnimation: DesktopMinimizeAnimation;
    sleepPreventionMode: DesktopSleepPreventionMode;
    showAppDeveloperSources: boolean;
    themeSource: DesktopThemeSource;
    updateChannel: DesktopUpdateChannel;
    updatePolicy: DesktopUpdatePolicy;
    workbenchShortcuts: DesktopWorkbenchShortcuts;
    workbenchWindowSnapping?: DesktopWorkbenchWindowSnapping;
  } {
    const hasWorkbenchWindowSnappingOverride =
      "workbenchWindowSnapping" in overrides;
    const workbenchWindowSnapping = normalizeDesktopWorkbenchWindowSnapping(
      overrides.workbenchWindowSnapping ?? this.store.workbenchWindowSnapping
    );
    return {
      // Keep the required wire-contract field, but stop round-tripping the
      // frozen legacy provider-keyed defaults through renderer state.
      agentComposerDefaultsByProvider: {},
      agentGuiConversationRailCollapsedByProvider:
        normalizeDesktopAgentGuiConversationRailCollapsedByProvider(
          overrides.agentGuiConversationRailCollapsedByProvider ??
            this.store.agentGuiConversationRailCollapsedByProvider
        ),
      agentConversationDetailMode: normalizeDesktopAgentConversationDetailMode(
        overrides.agentConversationDetailMode ??
          this.store.agentConversationDetailMode
      ),
      // The dual-dock (legacySplit) layout has been removed; the stored
      // preference is pinned to the unified layout.
      agentDockLayout: "unified",
      appCatalogChannel:
        overrides.appCatalogChannel ?? this.store.appCatalogChannel,
      browserUseConnectionMode:
        overrides.browserUseConnectionMode ??
        this.store.browserUseConnectionMode,
      defaultAgentProvider:
        overrides.defaultAgentProvider ?? this.store.defaultAgentProvider,
      dockIconStyle: overrides.dockIconStyle ?? this.store.dockIconStyle,
      dockPlacement: overrides.dockPlacement ?? this.store.dockPlacement,
      featureFlags: normalizeDesktopFeatureFlags(
        overrides.featureFlags ?? this.store.featureFlags
      ),
      fileDefaultOpenersByExtension:
        normalizeDesktopFileDefaultOpenersByExtension(
          overrides.fileDefaultOpenersByExtension ??
            this.store.fileDefaultOpenersByExtension
        ),
      locale: overrides.locale ?? this.store.locale,
      minimizeAnimation:
        overrides.minimizeAnimation ?? this.store.minimizeAnimation,
      sleepPreventionMode:
        overrides.sleepPreventionMode ?? this.store.sleepPreventionMode,
      showAppDeveloperSources:
        overrides.showAppDeveloperSources ?? this.store.showAppDeveloperSources,
      themeSource: overrides.themeSource ?? this.store.theme.source,
      updateChannel: overrides.updateChannel ?? this.store.updateChannel,
      updatePolicy: overrides.updatePolicy ?? this.store.updatePolicy,
      workbenchShortcuts: normalizeDesktopWorkbenchShortcuts(
        overrides.workbenchShortcuts ?? this.store.workbenchShortcuts
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
}
