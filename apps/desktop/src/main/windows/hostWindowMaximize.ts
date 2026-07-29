export interface HostWindowMaximizePort {
  isFullScreen(): boolean;
  isMaximized(): boolean;
  maximize(): void;
  setFullScreen(fullScreen: boolean): void;
  unmaximize(): void;
}

export function toggleHostWindowMaximize(
  hostWindow: HostWindowMaximizePort,
  windowKind: "agent" | "workspace" | null
): void {
  if (windowKind === "agent") {
    hostWindow.setFullScreen(!hostWindow.isFullScreen());
    return;
  }
  if (windowKind === "workspace") {
    if (hostWindow.isMaximized()) {
      hostWindow.unmaximize();
    } else {
      hostWindow.maximize();
    }
  }
}
