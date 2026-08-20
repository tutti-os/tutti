import type { BrowserWindowConstructorOptions } from "electron";
import type { DesktopThemeAppearance } from "../../shared/theme/index.ts";

export type WorkspaceWindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  | "autoHideMenuBar"
  | "frame"
  | "maximizable"
  | "titleBarOverlay"
  | "titleBarStyle"
>;

const windowsTitleBarSymbolColors: Record<DesktopThemeAppearance, string> = {
  dark: "rgba(255, 255, 255, 0.92)",
  light: "rgba(17, 24, 39, 0.88)"
};

export function resolveWorkspaceWindowTitleBarOverlay(
  appearance: DesktopThemeAppearance
) {
  return {
    color: "rgba(0, 0, 0, 0)",
    height: 52,
    symbolColor: windowsTitleBarSymbolColors[appearance]
  } as const;
}

export function resolveWorkspaceWindowChromeOptions(
  platform: NodeJS.Platform,
  windowKind: "agent" | "workspace",
  appearance: DesktopThemeAppearance
): WorkspaceWindowChromeOptions {
  if (platform === "win32") {
    return {
      // Keep the native application menu available as an Alt-key fallback,
      // while the custom workspace header owns the visible application chrome.
      // The native caption buttons remain system-managed, but are overlaid on
      // that header so Windows does not render a second title-bar row.
      autoHideMenuBar: true,
      titleBarOverlay: resolveWorkspaceWindowTitleBarOverlay(appearance),
      titleBarStyle: "hidden"
    };
  }

  if (windowKind !== "agent") {
    return {};
  }

  return {
    frame: false,
    maximizable: false
  };
}
