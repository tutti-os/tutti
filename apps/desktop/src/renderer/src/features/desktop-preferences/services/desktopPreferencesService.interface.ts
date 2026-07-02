import { createDecorator } from "@tutti-os/infra/di";
import type { DesktopLocale } from "@shared/i18n";
import type {
  DesktopAgentComposerDefaults,
  DesktopAgentConversationDetailMode,
  DesktopAgentDockLayout,
  DesktopAgentProvider,
  DesktopAppCatalogChannel,
  DesktopBrowserUseConnectionMode,
  DesktopDockIconStyle,
  DesktopDockPlacement,
  DesktopFileDefaultOpenersByExtension,
  DesktopMinimizeAnimation,
  DesktopSleepPreventionMode,
  DesktopUpdateChannel,
  DesktopUpdatePolicy,
  DesktopWorkbenchWindowSnapping
} from "@shared/preferences";
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";
import type { DesktopPreferencesReadableStoreState } from "./desktopPreferencesTypes.ts";

export interface IDesktopPreferencesService {
  readonly _serviceBrand: undefined;
  readonly store: DesktopPreferencesReadableStoreState;

  setDefaultAgentProvider(
    provider: DesktopAgentProvider
  ): Promise<DesktopAgentProvider>;
  setAgentConversationDetailMode(
    mode: DesktopAgentConversationDetailMode
  ): Promise<DesktopAgentConversationDetailMode>;
  setAgentDockLayout(
    layout: DesktopAgentDockLayout
  ): Promise<DesktopAgentDockLayout>;
  setAppCatalogChannel(
    channel: DesktopAppCatalogChannel
  ): Promise<DesktopAppCatalogChannel>;
  setBrowserUseConnectionMode(
    mode: DesktopBrowserUseConnectionMode
  ): Promise<DesktopBrowserUseConnectionMode>;
  setDockPlacement(
    placement: DesktopDockPlacement
  ): Promise<DesktopDockPlacement>;
  setDockIconStyle(style: DesktopDockIconStyle): Promise<DesktopDockIconStyle>;
  setFileDefaultOpenersByExtension(
    openersByExtension: DesktopFileDefaultOpenersByExtension
  ): Promise<DesktopFileDefaultOpenersByExtension>;
  setLocale(locale: DesktopLocale): Promise<DesktopLocale>;
  setMinimizeAnimation(
    animation: DesktopMinimizeAnimation
  ): Promise<DesktopMinimizeAnimation>;
  setSleepPreventionMode(
    mode: DesktopSleepPreventionMode
  ): Promise<DesktopSleepPreventionMode>;
  setShowAppDeveloperSources(show: boolean): Promise<boolean>;
  setThemeSource(source: DesktopThemeSource): Promise<DesktopThemeState>;
  setUpdateChannel(
    channel: DesktopUpdateChannel
  ): Promise<DesktopUpdateChannel>;
  setUpdatePolicy(policy: DesktopUpdatePolicy): Promise<DesktopUpdatePolicy>;
  setWorkbenchWindowSnapping(
    value: DesktopWorkbenchWindowSnapping
  ): Promise<DesktopWorkbenchWindowSnapping>;
  rememberAgentComposerDefaults(
    provider: DesktopAgentProvider,
    defaults: DesktopAgentComposerDefaults | null
  ): Promise<void>;
  rememberAgentGuiConversationRailCollapsed(
    provider: DesktopAgentProvider,
    collapsed: boolean
  ): Promise<void>;
}

export const IDesktopPreferencesService =
  createDecorator<IDesktopPreferencesService>("desktop-preferences-service");
