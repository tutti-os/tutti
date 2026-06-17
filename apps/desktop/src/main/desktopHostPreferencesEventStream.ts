import {
  createTuttidEventStreamClient,
  type TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopThemeSource } from "../shared/theme/index.ts";
import type { DesktopHostPreferencesState } from "./desktopHostPreferences.ts";
import type { DesktopLogger } from "./logging.ts";
import type { AppUpdateService } from "./update/appUpdateService.ts";
import {
  resolveDesktopBusinessEventStreamUrl,
  type DesktopDaemonEndpoint
} from "./transport/paths.ts";

export interface DesktopHostPreferencesEventStream {
  dispose(): void;
}

export interface DesktopHostPreferencesEventStreamDependencies {
  applyThemeSource: (source: DesktopThemeSource) => unknown;
  eventStreamClient: TuttidEventStreamClient;
  logger: DesktopLogger;
  preferences: DesktopHostPreferencesState;
  updateService?: Pick<AppUpdateService, "configure">;
  syncWindowBackgroundColors: () => void;
}

export function createDesktopHostPreferencesEventStreamClient(
  endpoint: DesktopDaemonEndpoint
): TuttidEventStreamClient {
  return createTuttidEventStreamClient({
    resolveUrl: () => resolveDesktopBusinessEventStreamUrl(endpoint)
  });
}

export function connectDesktopHostPreferencesEventStream(
  deps: DesktopHostPreferencesEventStreamDependencies
): DesktopHostPreferencesEventStream {
  const unsubscribe = deps.eventStreamClient.subscribe(
    "preferences.desktop.updated",
    (event) => {
      const nextPreferences = event.payload.preferences;
      const themeSourceChanged =
        deps.preferences.getThemeSource() !== nextPreferences.themeSource;

      deps.preferences.sync({
        agentComposerDefaultsByProvider:
          nextPreferences.agentComposerDefaultsByProvider,
        browserUseConnectionMode: nextPreferences.browserUseConnectionMode,
        defaultAgentProvider: nextPreferences.defaultAgentProvider,
        dockIconStyle: nextPreferences.dockIconStyle,
        dockPlacement: nextPreferences.dockPlacement,
        locale: nextPreferences.locale,
        sleepPreventionMode: nextPreferences.sleepPreventionMode,
        themeSource: nextPreferences.themeSource,
        updateChannel: nextPreferences.updateChannel,
        updatePolicy: nextPreferences.updatePolicy
      });

      void deps.updateService
        ?.configure({
          channel: nextPreferences.updateChannel,
          policy: nextPreferences.updatePolicy
        })
        .catch((error: unknown) => {
          deps.logger.warn("failed to apply desktop update preferences", {
            error: error instanceof Error ? error.message : String(error)
          });
        });

      if (themeSourceChanged) {
        deps.applyThemeSource(nextPreferences.themeSource);
        deps.syncWindowBackgroundColors();
      }
    }
  );

  void deps.eventStreamClient.connect().catch((error: unknown) => {
    deps.logger.warn("failed to connect desktop preferences event stream", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

  return {
    dispose() {
      unsubscribe();
      deps.eventStreamClient.dispose();
    }
  };
}
