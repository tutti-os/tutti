import { app } from "electron";
import {
  resolveDesktopLocaleFromCandidates,
  type DesktopLocale
} from "@shared/i18n";

function resolveDesktopLocaleFromElectron(input: {
  appLocale?: string | null;
  preferredSystemLanguages?: readonly string[] | null;
}): DesktopLocale {
  return resolveDesktopLocaleFromCandidates([
    ...(input.preferredSystemLanguages ?? []),
    input.appLocale
  ]);
}

export function getSystemDesktopLocale(): DesktopLocale {
  return resolveDesktopLocaleFromElectron({
    appLocale: app.getLocale(),
    preferredSystemLanguages:
      typeof app.getPreferredSystemLanguages === "function"
        ? app.getPreferredSystemLanguages()
        : null
  });
}
