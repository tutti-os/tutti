import type { BrowserWindowConstructorOptions } from "electron";

export type WorkspaceWindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  | "autoHideMenuBar"
  | "frame"
  | "maximizable"
  | "titleBarOverlay"
  | "titleBarStyle"
>;

const windowsTitleBarOverlay = {
  color: "rgba(0, 0, 0, 0)",
  height: 52,
  symbolColor: "rgba(255, 255, 255, 0.92)"
} as const;

export function resolveWorkspaceWindowChromeOptions(
  platform: NodeJS.Platform,
  windowKind: "agent" | "workspace"
): WorkspaceWindowChromeOptions {
  if (platform === "win32") {
    return {
      // Keep the native application menu available as an Alt-key fallback,
      // while the custom workspace header owns the visible application chrome.
      // The native caption buttons remain system-managed, but are overlaid on
      // that header so Windows does not render a second title-bar row.
      autoHideMenuBar: true,
      titleBarOverlay: windowsTitleBarOverlay,
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
