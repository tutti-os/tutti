import type { MenuItemConstructorOptions } from "electron";
import type { DesktopFusionWindowKind } from "../../shared/contracts/fusion.ts";
import type { createTranslator } from "../../shared/i18n/index.ts";

interface FusionLauncherMenuTemplateInput {
  onBackgroundTasks(): void;
  onNewWindow(kind: DesktopFusionWindowKind): void;
  onOpenSettings(): void;
  onShowDock(): void;
  translator: ReturnType<typeof createTranslator>;
  workspaceAvailable: boolean;
}

interface FusionTrayMenuTemplateInput extends FusionLauncherMenuTemplateInput {
  onQuit(): void;
}

export function createFusionDockMenuTemplate(
  input: FusionLauncherMenuTemplateInput
): MenuItemConstructorOptions[] {
  return createFusionLauncherMenuTemplate(input);
}

export function createFusionTrayMenuTemplate(
  input: FusionTrayMenuTemplateInput
): MenuItemConstructorOptions[] {
  return [
    ...createFusionLauncherMenuTemplate(input),
    { type: "separator" },
    {
      label: input.translator.t("desktop.menu.quit"),
      click: input.onQuit
    }
  ];
}

function createFusionLauncherMenuTemplate(
  input: FusionLauncherMenuTemplateInput
): MenuItemConstructorOptions[] {
  return [
    {
      label: fusionTranslation(
        input.translator,
        "desktop.fusion.tray.showDock"
      ),
      click: input.onShowDock
    },
    {
      label: fusionTranslation(
        input.translator,
        "desktop.fusion.tray.newWindow"
      ),
      enabled: input.workspaceAvailable,
      submenu: fusionLaunchKinds.map((kind) => ({
        label: fusionTranslation(
          input.translator,
          `desktop.fusion.windowKinds.${fusionWindowKindTranslationKey(kind)}`
        ),
        click: () => input.onNewWindow(kind)
      }))
    },
    {
      label: fusionTranslation(
        input.translator,
        "desktop.fusion.tray.backgroundTasks"
      ),
      click: input.onBackgroundTasks
    },
    { type: "separator" },
    {
      label: fusionTranslation(
        input.translator,
        "desktop.fusion.tray.settings"
      ),
      enabled: input.workspaceAvailable,
      click: input.onOpenSettings
    }
  ];
}

const fusionLaunchKinds: readonly DesktopFusionWindowKind[] = [
  "agent",
  "terminal",
  "browser",
  "files",
  "app-center",
  "issue-manager"
];

function fusionTranslation(
  translator: ReturnType<typeof createTranslator>,
  key: string
): string {
  return (translator.t as unknown as (translationKey: string) => string)(key);
}

function fusionWindowKindTranslationKey(kind: DesktopFusionWindowKind): string {
  return kind.replace(/-([a-z])/gu, (_match, letter: string) =>
    letter.toUpperCase()
  );
}
