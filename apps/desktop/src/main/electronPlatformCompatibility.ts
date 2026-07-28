export interface DesktopElectronCommandLine {
  appendSwitch(name: string, value?: string): void;
}

/**
 * Keep the current desktop window contract while Electron's native Wayland
 * path cannot provide global bounds, deterministic positioning, or
 * programmatic content resizing.
 */
export function applyDesktopElectronPlatformCompatibility(
  commandLine: DesktopElectronCommandLine,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === "linux") {
    commandLine.appendSwitch("ozone-platform", "x11");
  }
}
