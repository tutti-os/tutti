import type { DesktopLocale } from "@shared/i18n";
import type {
  DesktopAgentComposerDefaultsByProvider,
  DesktopAgentProvider,
  DesktopBrowserUseConnectionMode,
  DesktopDockIconStyle,
  DesktopDockPlacement,
  DesktopSleepPreventionMode,
  DesktopUpdateChannel,
  DesktopUpdatePolicy
} from "@shared/preferences";
import type { DesktopThemeState } from "@shared/theme";
import { proxy } from "valtio";
import type { DesktopPreferencesStoreState } from "../desktopPreferencesTypes.ts";

export function createDesktopPreferencesStore(input: {
  agentComposerDefaultsByProvider?: DesktopAgentComposerDefaultsByProvider;
  browserUseConnectionMode: DesktopBrowserUseConnectionMode;
  defaultAgentProvider: DesktopAgentProvider;
  dockIconStyle: DesktopDockIconStyle;
  dockPlacement: DesktopDockPlacement;
  locale: DesktopLocale;
  sleepPreventionMode: DesktopSleepPreventionMode;
  theme: DesktopThemeState;
  updateChannel: DesktopUpdateChannel;
  updatePolicy: DesktopUpdatePolicy;
}): DesktopPreferencesStoreState {
  return proxy({
    changingDefaultAgentProvider: null,
    changingBrowserUseConnectionMode: null,
    changingDockIconStyle: null,
    changingDockPlacement: null,
    changingLocale: null,
    changingSleepPreventionMode: null,
    changingThemeSource: null,
    changingUpdateChannel: null,
    changingUpdatePolicy: null,
    agentComposerDefaultsByProvider:
      input.agentComposerDefaultsByProvider ?? {},
    browserUseConnectionMode: input.browserUseConnectionMode,
    defaultAgentProvider: input.defaultAgentProvider,
    dockIconStyle: input.dockIconStyle,
    dockPlacement: input.dockPlacement,
    locale: input.locale,
    sleepPreventionMode: input.sleepPreventionMode,
    theme: input.theme,
    updateChannel: input.updateChannel,
    updatePolicy: input.updatePolicy
  });
}
