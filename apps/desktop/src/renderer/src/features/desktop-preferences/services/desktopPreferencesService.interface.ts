import { createDecorator } from "@tutti-os/infra/di";
import type { DesktopLocale } from "@shared/i18n";
import type {
  DesktopAgentComposerDefaultsPatch,
  DesktopAgentConversationDetailMode,
  DesktopAgentProvider,
  DesktopDefaultAgentProvider,
  DesktopAppCatalogChannel,
  DesktopBrowserUseConnectionMode,
  DesktopDockIconStyle,
  DesktopDockPlacement,
  DesktopFeatureFlags,
  DesktopFileDefaultOpenersByExtension,
  DesktopMinimizeAnimation,
  DesktopSleepPreventionMode,
  DesktopUpdateChannel,
  DesktopUpdatePolicy,
  DesktopWorkbenchShortcuts,
  DesktopWorkbenchWindowSnapping
} from "@shared/preferences";
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";
import type { DesktopPreferencesReadableStoreState } from "./desktopPreferencesTypes.ts";

export type DesktopAgentComposerDefaultsField =
  keyof DesktopAgentComposerDefaultsPatch;

export interface DesktopAgentComposerDefaultsPatchResult {
  acknowledgedFields: DesktopAgentComposerDefaultsField[];
  supersededFields: DesktopAgentComposerDefaultsField[];
}

export interface IDesktopPreferencesService {
  readonly _serviceBrand: undefined;
  readonly store: DesktopPreferencesReadableStoreState;

  setDefaultAgentProvider(
    provider: DesktopDefaultAgentProvider
  ): Promise<DesktopDefaultAgentProvider>;
  setAgentConversationDetailMode(
    mode: DesktopAgentConversationDetailMode
  ): Promise<DesktopAgentConversationDetailMode>;
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
  setFeatureFlags(flags: DesktopFeatureFlags): Promise<DesktopFeatureFlags>;
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
  setWorkbenchShortcuts(
    shortcuts: DesktopWorkbenchShortcuts
  ): Promise<DesktopWorkbenchShortcuts>;
  setWorkbenchWindowSnapping(
    value: DesktopWorkbenchWindowSnapping
  ): Promise<DesktopWorkbenchWindowSnapping>;
  rememberAgentComposerDefaultsForAgentTarget(
    agentTargetId: string,
    defaults: DesktopAgentComposerDefaultsPatch | null
  ): Promise<DesktopAgentComposerDefaultsPatchResult>;
  rememberAgentGuiConversationRailCollapsed(
    provider: DesktopAgentProvider,
    collapsed: boolean
  ): Promise<void>;
}

export const IDesktopPreferencesService =
  createDecorator<IDesktopPreferencesService>("desktop-preferences-service");
