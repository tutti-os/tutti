export interface FusionTrayClickEvent {
  ctrlKey?: boolean;
}

export interface FusionTrayInteractionHandlers {
  handleClick(event: FusionTrayClickEvent): void;
  handleContextMenu(): void;
}

export function showFusionTrayContextMenu<
  TMenu extends { popup(): void }
>(input: {
  menu: TMenu;
  platform?: NodeJS.Platform;
  tray: { popUpContextMenu(menu: TMenu): void };
}): void {
  const platform = input.platform ?? process.platform;
  if (platform === "darwin" || platform === "win32") {
    input.tray.popUpContextMenu(input.menu);
    return;
  }
  input.menu.popup();
}

export function createFusionTrayInteractionHandlers(input: {
  openContextMenu(): void;
  toggleDock(): void;
}): FusionTrayInteractionHandlers {
  return {
    handleClick(event) {
      if (event.ctrlKey === true) {
        input.openContextMenu();
        return;
      }
      input.toggleDock();
    },
    handleContextMenu() {
      input.openContextMenu();
    }
  };
}
