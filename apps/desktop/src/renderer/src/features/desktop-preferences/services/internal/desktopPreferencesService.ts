import type { DesktopLocale } from "@shared/i18n";
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";
import type {
  DesktopPreferencesStateResponse,
  PutDesktopPreferencesRequest
} from "@tutti-os/client-tuttid-ts";
import { withDesktopWorkspaceUiMode } from "../../../../../../shared/featureFlags/catalog.ts";
import type { IDesktopPreferencesService } from "../desktopPreferencesService.interface.ts";
import type { DesktopAgentComposerDefaultsPatchResult } from "../desktopPreferencesService.interface.ts";
import type { DesktopPreferencesClient } from "./adapters/desktopPreferencesClient.ts";
import { createDesktopPreferencesStore } from "./desktopPreferencesStore.ts";
import { AgentComposerDefaultsPatchCoordinator } from "./agentComposerDefaultsPatchCoordinator.ts";
import {
  applyDesktopPreferenceLocale,
  applyDesktopPreferenceTheme,
  applyDesktopPreferencesProjection,
  createDesktopPreferencesMutation,
  type DesktopPreferencesOverrides
} from "./desktopPreferencesProjection.ts";
import {
  desktopAgentGuiConversationRailCollapsedByProviderEqual,
  desktopAgentSessionLaunchModesByWorkspaceEqual,
  defaultDesktopAgentCliUpdateCheckEnabled,
  defaultDesktopAgentProvider,
  defaultDesktopAgentSessionLaunchModesByWorkspace,
  defaultDesktopAgentConversationDetailMode,
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
  defaultDesktopWorkbenchWindowSnapping,
  desktopFeatureFlagsEqual,
  mergeDesktopAgentGuiConversationRailCollapsedByProvider,
  mergeDesktopAgentSessionLaunchMode,
  normalizeDesktopAgentCliUpdateCheckEnabled,
  normalizeDesktopAgentConversationDetailMode,
  normalizeDeletedAgentConversationRetentionDays,
  normalizeDesktopFeatureFlags,
  normalizeDesktopFileDefaultOpenersByExtension,
  normalizeDesktopWorkbenchShortcuts,
  normalizeDesktopWorkbenchWindowSnapping,
  desktopFileDefaultOpenersByExtensionEqual,
  desktopWorkbenchShortcutsEqual,
  desktopWorkbenchWindowSnappingEqual,
  type DesktopAgentComposerDefaultsPatch,
  type DesktopAgentProvider,
  type DesktopAgentSessionLaunchMode,
  type DesktopDefaultAgentProvider,
  type DesktopAgentConversationDetailMode,
  type DesktopAppCatalogChannel,
  type DesktopBrowserUseConnectionMode,
  type DesktopDockIconStyle,
  type DesktopDockPlacement,
  type DeletedAgentConversationRetentionDays,
  type DesktopFeatureFlags,
  type DesktopWorkspaceUiMode,
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
  ensureInitialized?: (
    candidate: PutDesktopPreferencesRequest["preferences"]
  ) => Promise<DesktopPreferencesStateResponse>;
  initialDockPlacement?: DesktopDockPlacement;
  initialLocale: DesktopLocale;
  initialTheme: DesktopThemeState;
  initialWorkspaceUiMode?: DesktopWorkspaceUiMode;
  resolveTheme: (source: DesktopThemeSource) => DesktopThemeState;
}

export class DesktopPreferencesService implements IDesktopPreferencesService {
  readonly _serviceBrand: undefined;
  readonly store;

  private readonly dependencies: DesktopPreferencesServiceDependencies;
  private readonly agentComposerDefaultsPatchCoordinator: AgentComposerDefaultsPatchCoordinator;
  private readonly initialPreferencesHydration: Promise<void>;
  private readonly unsubscribePreferencesUpdates: () => void;
  private disposed = false;
  private preferencesInitialized = false;
  private preferencesInitialization: Promise<void> | null = null;

  constructor(dependencies: DesktopPreferencesServiceDependencies) {
    this.dependencies = dependencies;
    this.agentComposerDefaultsPatchCoordinator =
      new AgentComposerDefaultsPatchCoordinator({
        publish: (input) =>
          this.dependencies.client.patchAgentComposerDefaultsForTarget(input)
      });
    this.store = createDesktopPreferencesStore({
      agentCliUpdateCheckEnabled: defaultDesktopAgentCliUpdateCheckEnabled,
      agentComposerDefaultsByProvider: {},
      agentComposerDefaultsByAgentTarget: {},
      agentGuiConversationRailCollapsedByProvider: {},
      agentSessionLaunchModesByWorkspace:
        defaultDesktopAgentSessionLaunchModesByWorkspace,
      agentConversationDetailMode: defaultDesktopAgentConversationDetailMode,
      appCatalogChannel: defaultDesktopAppCatalogChannel,
      browserUseConnectionMode: defaultDesktopBrowserUseConnectionMode,
      defaultAgentProvider: defaultDesktopAgentProvider,
      dockIconStyle: defaultDesktopDockIconStyle,
      dockPlacement:
        this.dependencies.initialDockPlacement ?? defaultDesktopDockPlacement,
      deletedAgentConversationRetentionDays:
        defaultDeletedAgentConversationRetentionDays,
      featureFlags: this.dependencies.initialWorkspaceUiMode
        ? withDesktopWorkspaceUiMode(
            defaultDesktopFeatureFlags,
            this.dependencies.initialWorkspaceUiMode
          )
        : defaultDesktopFeatureFlags,
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
          this.preferencesInitialized = true;
        }
      );
    this.initialPreferencesHydration = this.hydrateInitialPreferences();
    void this.connectAfterInitialPreferencesHydration();
  }

  whenInitialPreferencesHydrated(): Promise<void> {
    return this.initialPreferencesHydration;
  }

  dispose(): void {
    this.disposed = true;
    this.agentComposerDefaultsPatchCoordinator.dispose();
    this.unsubscribePreferencesUpdates();
    this.dependencies.client.dispose();
  }

  async setAgentCliUpdateCheckEnabled(enabled: boolean): Promise<boolean> {
    if (this.store.changingAgentCliUpdateCheckEnabled === enabled) {
      return enabled;
    }

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
    }
    const previousEnabled = this.store.agentCliUpdateCheckEnabled;
    this.store.changingAgentCliUpdateCheckEnabled = enabled;
    this.store.agentCliUpdateCheckEnabled = enabled;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            agentCliUpdateCheckEnabled: enabled
          })
        });
      return normalizeDesktopAgentCliUpdateCheckEnabled(
        authoritativePreferences.agentCliUpdateCheckEnabled
      );
    } catch (error) {
      this.store.agentCliUpdateCheckEnabled = previousEnabled;
      throw error;
    } finally {
      if (this.store.changingAgentCliUpdateCheckEnabled === enabled) {
        this.store.changingAgentCliUpdateCheckEnabled = null;
      }
    }
  }

  async setDefaultAgentProvider(
    provider: DesktopDefaultAgentProvider
  ): Promise<DesktopDefaultAgentProvider> {
    if (this.store.changingDefaultAgentProvider === provider) {
      return provider;
    }

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

  async setDeletedAgentConversationRetentionDays(
    days: DeletedAgentConversationRetentionDays
  ): Promise<DeletedAgentConversationRetentionDays> {
    const nextDays = normalizeDeletedAgentConversationRetentionDays(days);
    if (this.store.changingDeletedAgentConversationRetentionDays === nextDays) {
      return nextDays;
    }
    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
    }
    const previousDays = this.store.deletedAgentConversationRetentionDays;
    this.store.changingDeletedAgentConversationRetentionDays = nextDays;
    this.store.deletedAgentConversationRetentionDays = nextDays;
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({
            deletedAgentConversationRetentionDays: nextDays
          })
        });
      return normalizeDeletedAgentConversationRetentionDays(
        authoritativePreferences.deletedAgentConversationRetentionDays
      );
    } catch (error) {
      this.store.deletedAgentConversationRetentionDays = previousDays;
      throw error;
    } finally {
      if (
        this.store.changingDeletedAgentConversationRetentionDays === nextDays
      ) {
        this.store.changingDeletedAgentConversationRetentionDays = null;
      }
    }
  }

  async setDockIconStyle(
    style: DesktopDockIconStyle
  ): Promise<DesktopDockIconStyle> {
    if (this.store.changingDockIconStyle === style) {
      return style;
    }

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
    }
    const previousLocale = this.store.locale;
    this.store.changingLocale = locale;
    applyDesktopPreferenceLocale(
      this.store,
      locale,
      this.dependencies.applyLocale
    );
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({ locale })
        });
      return authoritativePreferences.locale;
    } catch (error) {
      applyDesktopPreferenceLocale(
        this.store,
        previousLocale,
        this.dependencies.applyLocale
      );
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
    }
    const previousTheme = this.store.theme;
    const nextTheme = this.dependencies.resolveTheme(source);
    this.store.changingThemeSource = source;
    applyDesktopPreferenceTheme(
      this.store,
      nextTheme,
      this.dependencies.applyTheme
    );
    try {
      const authoritativePreferences =
        await this.dependencies.client.updateDesktopPreferences({
          preferences: this.currentPreferences({ themeSource: source })
        });
      return this.dependencies.resolveTheme(
        authoritativePreferences.themeSource
      );
    } catch (error) {
      applyDesktopPreferenceTheme(
        this.store,
        previousTheme,
        this.dependencies.applyTheme
      );
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
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
    if (!agentTargetId.trim() || Object.keys(defaults ?? {}).length === 0) {
      return this.agentComposerDefaultsPatchCoordinator.patch(
        agentTargetId,
        defaults
      );
    }
    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
    }
    return this.agentComposerDefaultsPatchCoordinator.patch(
      agentTargetId,
      defaults
    );
  }

  async rememberAgentGuiConversationRailCollapsed(
    provider: DesktopAgentProvider,
    collapsed: boolean
  ): Promise<void> {
    let previousCollapsedByProvider =
      this.store.agentGuiConversationRailCollapsedByProvider;
    let nextCollapsedByProvider =
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

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
    }
    previousCollapsedByProvider =
      this.store.agentGuiConversationRailCollapsedByProvider;
    nextCollapsedByProvider =
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

  async rememberAgentSessionLaunchMode(
    workspaceId: string,
    projectSectionKey: string,
    mode: DesktopAgentSessionLaunchMode
  ): Promise<void> {
    let previousModes = this.store.agentSessionLaunchModesByWorkspace;
    let nextModes = mergeDesktopAgentSessionLaunchMode(
      previousModes,
      workspaceId,
      projectSectionKey,
      mode
    );
    if (
      desktopAgentSessionLaunchModesByWorkspaceEqual(previousModes, nextModes)
    ) {
      return;
    }

    if (!this.preferencesInitialized) {
      await this.ensureInitializedForMutation();
    }
    previousModes = this.store.agentSessionLaunchModesByWorkspace;
    nextModes = mergeDesktopAgentSessionLaunchMode(
      previousModes,
      workspaceId,
      projectSectionKey,
      mode
    );
    if (
      desktopAgentSessionLaunchModesByWorkspaceEqual(previousModes, nextModes)
    ) {
      return;
    }

    this.store.agentSessionLaunchModesByWorkspace = nextModes;
    try {
      await this.dependencies.client.patchAgentSessionLaunchMode({
        workspaceId,
        projectSectionKey,
        mode
      });
    } catch (error) {
      if (
        desktopAgentSessionLaunchModesByWorkspaceEqual(
          this.store.agentSessionLaunchModesByWorkspace,
          nextModes
        )
      ) {
        this.store.agentSessionLaunchModesByWorkspace = previousModes;
      }
      throw error;
    }
  }

  private async hydrateInitialPreferences(): Promise<void> {
    try {
      const preferences =
        await this.dependencies.client.getDesktopPreferences();
      if (!this.disposed && preferences.initialized) {
        this.applyPreferences(preferences.preferences);
        this.preferencesInitialized = true;
      }
    } catch {
      // Keep the current in-memory defaults when initial preference hydration fails.
    }
  }

  private async connectAfterInitialPreferencesHydration(): Promise<void> {
    await this.initialPreferencesHydration;
    try {
      if (this.disposed) {
        return;
      }
      await this.dependencies.client.connect();
    } catch {
      // Keep the bootstrapped in-memory state when the event stream is unavailable.
    }
  }

  private applyPreferences(
    preferences: Parameters<
      DesktopPreferencesClient["updateDesktopPreferences"]
    >[0]["preferences"]
  ): void {
    applyDesktopPreferencesProjection({
      applyLocale: this.dependencies.applyLocale,
      applyTheme: this.dependencies.applyTheme,
      preferences,
      resolveTheme: this.dependencies.resolveTheme,
      store: this.store
    });
  }

  private async ensureInitializedForMutation(): Promise<void> {
    if (this.preferencesInitialized) {
      return;
    }
    if (this.preferencesInitialization) {
      return this.preferencesInitialization;
    }

    const ensureInitialized = this.dependencies.ensureInitialized;
    if (!ensureInitialized) {
      throw new Error(
        "Desktop preferences initialization is unavailable for mutation."
      );
    }

    const initialization = (async () => {
      const response = await ensureInitialized(this.currentPreferences());
      if (!response.initialized) {
        throw new Error(
          "Desktop preferences remained uninitialized before mutation."
        );
      }
      if (this.disposed) {
        throw new Error("Desktop preferences service was disposed.");
      }
      this.applyPreferences(response.preferences);
      this.preferencesInitialized = true;
    })();
    this.preferencesInitialization = initialization;
    try {
      await initialization;
    } finally {
      if (this.preferencesInitialization === initialization) {
        this.preferencesInitialization = null;
      }
    }
  }

  private currentPreferences(overrides: DesktopPreferencesOverrides = {}) {
    return createDesktopPreferencesMutation(this.store, overrides);
  }
}
