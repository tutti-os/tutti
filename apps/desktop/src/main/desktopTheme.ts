import { BrowserWindow, nativeTheme } from "electron";
import {
  defaultDesktopThemeSource,
  type DesktopThemeAppearance,
  type DesktopThemeSource,
  type DesktopThemeState
} from "../shared/theme/index.ts";

const desktopWindowBackgroundColors: Record<DesktopThemeAppearance, string> = {
  dark: "#0b1016",
  light: "#f7f4ee"
};

function resolveDesktopThemeAppearance(): DesktopThemeAppearance {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function resolveDesktopThemeSource(): DesktopThemeSource {
  const source = nativeTheme.themeSource;
  return source === "dark" || source === "light" || source === "system"
    ? source
    : defaultDesktopThemeSource;
}

export function getDesktopThemeState(
  source: DesktopThemeSource = resolveDesktopThemeSource()
): DesktopThemeState {
  return {
    appearance: resolveDesktopThemeAppearance(),
    source
  };
}

export function applyDesktopThemeSource(
  source: DesktopThemeSource
): DesktopThemeState {
  nativeTheme.themeSource = source;
  return getDesktopThemeState(source);
}

export function resolveDesktopWindowBackgroundColor(
  appearance: DesktopThemeAppearance = resolveDesktopThemeAppearance()
): string {
  return desktopWindowBackgroundColors[appearance];
}

export function syncDesktopWindowBackgroundColors(): void {
  const backgroundColor = resolveDesktopWindowBackgroundColor();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.setBackgroundColor(backgroundColor);
    }
  }
}
