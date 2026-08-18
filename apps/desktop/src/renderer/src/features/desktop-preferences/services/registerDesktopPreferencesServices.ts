import type { ServiceRegistry } from "@tutti-os/infra/di";
import type {
  DesktopPreferencesStateResponse,
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import { applyLocale, getActiveLocale } from "@renderer/i18n";
import {
  applyTheme,
  getActiveTheme,
  resolveDesktopThemeState
} from "@renderer/theme/runtime";
import { readInitialDockPlacementFromLocation } from "@shared/preferences";
import type { DesktopWorkspaceUiMode } from "@shared/preferences";
import { IDesktopPreferencesService } from "./desktopPreferencesService.interface.ts";
import { createDesktopPreferencesClient } from "./internal/adapters/desktopPreferencesClient.ts";
import { DesktopPreferencesService } from "./internal/desktopPreferencesService.ts";

export async function registerDesktopPreferencesServices(
  registry: ServiceRegistry,
  tuttidClient: TuttidClient,
  eventStreamClient: TuttidEventStreamClient,
  options: {
    ensureInitialized?: () => Promise<DesktopPreferencesStateResponse>;
    initialWorkspaceUiMode?: DesktopWorkspaceUiMode;
  } = {}
): Promise<IDesktopPreferencesService> {
  const service = new DesktopPreferencesService({
    applyLocale,
    applyTheme,
    client: createDesktopPreferencesClient(tuttidClient, eventStreamClient),
    ensureInitialized: (candidate) =>
      options.ensureInitialized
        ? options.ensureInitialized()
        : tuttidClient.putDesktopPreferences({
            writeMode: "initializeIfAbsent",
            preferences: candidate
          }),
    initialDockPlacement: readInitialDockPlacementFromLocation(),
    initialLocale: getActiveLocale(),
    initialTheme: getActiveTheme(),
    ...(options.initialWorkspaceUiMode
      ? { initialWorkspaceUiMode: options.initialWorkspaceUiMode }
      : {}),
    resolveTheme: resolveDesktopThemeState
  });
  await service.whenInitialPreferencesHydrated();
  registry.registerInstance(IDesktopPreferencesService, service);
  return service;
}
