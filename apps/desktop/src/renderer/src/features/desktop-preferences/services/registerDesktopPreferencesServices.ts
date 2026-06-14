import type { ServiceRegistry } from "@tutti-os/infra/di";
import type {
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
import { IDesktopPreferencesService } from "./desktopPreferencesService.interface.ts";
import { createDesktopPreferencesClient } from "./internal/adapters/desktopPreferencesClient.ts";
import { DesktopPreferencesService } from "./internal/desktopPreferencesService.ts";

export function registerDesktopPreferencesServices(
  registry: ServiceRegistry,
  tuttidClient: TuttidClient,
  eventStreamClient: TuttidEventStreamClient
): IDesktopPreferencesService {
  const service = new DesktopPreferencesService({
    applyLocale,
    applyTheme,
    client: createDesktopPreferencesClient(tuttidClient, eventStreamClient),
    initialDockPlacement: readInitialDockPlacementFromLocation(),
    initialLocale: getActiveLocale(),
    initialTheme: getActiveTheme(),
    resolveTheme: resolveDesktopThemeState
  });
  registry.registerInstance(IDesktopPreferencesService, service);
  return service;
}
