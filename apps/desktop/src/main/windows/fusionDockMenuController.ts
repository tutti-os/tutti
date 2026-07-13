import type { MenuItemConstructorOptions } from "electron";
import type { DesktopFusionWindowKind } from "../../shared/contracts/fusion.ts";
import type { DesktopLocale } from "../../shared/i18n/index.ts";
import { createTranslator } from "../../shared/i18n/index.ts";
import { createFusionDockMenuTemplate } from "./fusionTrayMenu.ts";

export interface FusionDockMenuController {
  dispose(): void;
  refresh(workspaceId: string | null): void;
}

interface FusionDockMenuHost<TMenu> {
  setMenu(menu: TMenu): void;
}

export function createFusionDockMenuController<TMenu>(options: {
  buildMenu(template: MenuItemConstructorOptions[]): TMenu;
  dock: FusionDockMenuHost<TMenu> | null;
  getLocale(): DesktopLocale;
  onBackgroundTasks(): void;
  onNewWindow(kind: DesktopFusionWindowKind, workspaceId: string): void;
  onOpenSettings(workspaceId: string): void;
  onShowDock(): void;
}): FusionDockMenuController {
  let menuInstalled = false;

  return {
    dispose() {
      if (!options.dock || !menuInstalled) {
        return;
      }
      options.dock.setMenu(options.buildMenu([]));
      menuInstalled = false;
    },
    refresh(workspaceId) {
      if (!options.dock) {
        return;
      }
      const translator = createTranslator(options.getLocale());
      options.dock.setMenu(
        options.buildMenu(
          createFusionDockMenuTemplate({
            onBackgroundTasks: options.onBackgroundTasks,
            onNewWindow: (kind) => {
              if (workspaceId) {
                options.onNewWindow(kind, workspaceId);
              }
            },
            onOpenSettings: () => {
              if (workspaceId) {
                options.onOpenSettings(workspaceId);
              }
            },
            onShowDock: options.onShowDock,
            translator,
            workspaceAvailable: Boolean(workspaceId)
          })
        )
      );
      menuInstalled = true;
    }
  };
}
