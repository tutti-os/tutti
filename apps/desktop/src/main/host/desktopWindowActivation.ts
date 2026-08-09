export interface DesktopWindowActivationApplication {
  focus(options?: { steal?: boolean }): void;
  setActivationPolicy(policy: "regular" | "accessory" | "prohibited"): void;
  show(): void;
}

export interface DesktopWindowActivationTarget {
  focus(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
}

/**
 * Restores both application-level and window-level foreground state.
 *
 * On macOS a visible BrowserWindow is not sufficient to make an Electron app
 * a regular foreground application. Auxiliary windows such as the screenshot
 * selector may suppress Dock and application-menu presence, so an explicit
 * regular activation policy must be restored before focusing the target.
 */
export function activateDesktopWindow(
  application: DesktopWindowActivationApplication,
  window: DesktopWindowActivationTarget,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (window.isDestroyed()) {
    return false;
  }

  if (platform === "darwin") {
    application.setActivationPolicy("regular");
    application.show();
    application.focus({ steal: true });
  } else {
    application.focus();
  }

  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
  return true;
}
