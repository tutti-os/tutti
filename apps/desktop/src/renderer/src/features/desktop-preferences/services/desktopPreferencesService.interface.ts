import { createDecorator } from "@tutti-os/infra/di";
import type { DesktopLocale } from "@shared/i18n";
import type {
  DesktopAgentComposerDefaults,
  DesktopAgentProvider,
  DesktopDockIconStyle,
  DesktopDockPlacement,
  DesktopSleepPreventionMode,
  DesktopUpdateChannel,
  DesktopUpdatePolicy
} from "@shared/preferences";
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";
import type { DesktopPreferencesReadableStoreState } from "./desktopPreferencesTypes.ts";

export interface IDesktopPreferencesService {
  readonly _serviceBrand: undefined;
  readonly store: DesktopPreferencesReadableStoreState;

  setDefaultAgentProvider(
    provider: DesktopAgentProvider
  ): Promise<DesktopAgentProvider>;
  setDockPlacement(
    placement: DesktopDockPlacement
  ): Promise<DesktopDockPlacement>;
  setDockIconStyle(style: DesktopDockIconStyle): Promise<DesktopDockIconStyle>;
  setLocale(locale: DesktopLocale): Promise<DesktopLocale>;
  setSleepPreventionMode(
    mode: DesktopSleepPreventionMode
  ): Promise<DesktopSleepPreventionMode>;
  setThemeSource(source: DesktopThemeSource): Promise<DesktopThemeState>;
  setUpdateChannel(
    channel: DesktopUpdateChannel
  ): Promise<DesktopUpdateChannel>;
  setUpdatePolicy(policy: DesktopUpdatePolicy): Promise<DesktopUpdatePolicy>;
  rememberAgentComposerDefaults(
    provider: DesktopAgentProvider,
    defaults: DesktopAgentComposerDefaults | null
  ): Promise<void>;
}

export const IDesktopPreferencesService =
  createDecorator<IDesktopPreferencesService>("desktop-preferences-service");
