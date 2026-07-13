import { app, Menu, nativeImage, Tray } from "electron";
import type { DesktopFusionWindowKind } from "../../shared/contracts/fusion.ts";
import type { DesktopLocale } from "../../shared/i18n/index.ts";
import { createTranslator } from "../../shared/i18n/index.ts";
import {
  createFusionTrayInteractionHandlers,
  showFusionTrayContextMenu
} from "./fusionTrayInteraction.ts";
import {
  createFusionDockMenuController,
  type FusionDockMenuController
} from "./fusionDockMenuController.ts";
import { resolveFusionTrayIconPath } from "./fusionTrayIcon.ts";
import { createFusionTrayMenuTemplate } from "./fusionTrayMenu.ts";

export interface FusionTrayController {
  dispose(): void;
  ensure(workspaceId: string | null): void;
  refresh(workspaceId: string | null): void;
}

export function createFusionTrayController(options: {
  getLocale(): DesktopLocale;
  onBackgroundTasks(): void;
  onNewWindow(kind: DesktopFusionWindowKind, workspaceId: string): void;
  onOpenSettings(workspaceId: string): void;
  onQuit(): void;
  onShowDock(): void;
  onToggleDock(): void;
  trayIconPath?: string;
}): FusionTrayController {
  let tray: Tray | null = null;
  let trayMenu: Menu | null = null;
  const dockMenu: FusionDockMenuController = createFusionDockMenuController({
    buildMenu: (template) => Menu.buildFromTemplate(template),
    dock: process.platform === "darwin" && app.dock ? app.dock : null,
    getLocale: options.getLocale,
    onBackgroundTasks: options.onBackgroundTasks,
    onNewWindow: options.onNewWindow,
    onOpenSettings: options.onOpenSettings,
    onShowDock: options.onShowDock
  });

  const refresh = (workspaceId: string | null): void => {
    if (!tray || tray.isDestroyed()) {
      return;
    }
    const translator = createTranslator(options.getLocale());
    trayMenu = Menu.buildFromTemplate(
      createFusionTrayMenuTemplate({
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
        onQuit: options.onQuit,
        onShowDock: options.onShowDock,
        translator,
        workspaceAvailable: Boolean(workspaceId)
      })
    );
    dockMenu.refresh(workspaceId);
  };

  return {
    dispose() {
      dockMenu.dispose();
      tray?.destroy();
      tray = null;
      trayMenu = null;
    },
    ensure(workspaceId) {
      if (tray && !tray.isDestroyed()) {
        refresh(workspaceId);
        return;
      }
      const image = nativeImage
        .createFromPath(
          options.trayIconPath ??
            resolveFusionTrayIconPath({
              appPath: app.getAppPath(),
              isPackaged: app.isPackaged,
              resourcesPath: process.resourcesPath
            })
        )
        .resize({ height: 18, width: 18 });
      if (process.platform === "darwin") {
        image.setTemplateImage(true);
      }
      tray = new Tray(image);
      tray.setToolTip(app.getName());
      const interactions = createFusionTrayInteractionHandlers({
        openContextMenu: () => {
          if (tray && trayMenu) {
            showFusionTrayContextMenu<Menu>({ menu: trayMenu, tray });
          }
        },
        toggleDock: options.onToggleDock
      });
      tray.on("click", (event) => interactions.handleClick(event));
      tray.on("right-click", () => interactions.handleContextMenu());
      refresh(workspaceId);
    },
    refresh
  };
}
