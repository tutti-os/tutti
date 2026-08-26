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
const workspaceTitleBarSymbolColor = "rgba(255, 255, 255, 0.92)";

export function resolveWorkspaceWindowTitleBarOverlay(
  appearance: DesktopThemeAppearance,
  windowKind: "agent" | "workspace"
) {
  return {
    color: "rgba(0, 0, 0, 0)",
    height: 52,
    // The OS workspace chrome deliberately keeps its controls white over the
    // wallpaper-backed dark header, independently of the global theme. Agent
    // windows use a theme-backed panel and can follow the active appearance.
    symbolColor:
      windowKind === "workspace"
        ? workspaceTitleBarSymbolColor
        : windowsTitleBarSymbolColors[appearance]
  } as const;
}

export function syncWorkspaceWindowTitleBarOverlayTargets<T>(input: {
  appearance: DesktopThemeAppearance;
  getWindowKind: (target: T) => "agent" | "workspace" | null;
  isDestroyed: (target: T) => boolean;
  setTitleBarOverlay: (
    target: T,
    overlay: ReturnType<typeof resolveWorkspaceWindowTitleBarOverlay>
  ) => void;
  targets: readonly T[];
}): void {
  for (const target of input.targets) {
    if (input.isDestroyed(target)) {
      continue;
    }
    const windowKind = input.getWindowKind(target);
    if (windowKind !== null) {
      input.setTitleBarOverlay(
        target,
        resolveWorkspaceWindowTitleBarOverlay(input.appearance, windowKind)
      );
    }
  }
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
      titleBarOverlay: resolveWorkspaceWindowTitleBarOverlay(
        appearance,
        windowKind
      ),
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
