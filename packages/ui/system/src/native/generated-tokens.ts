/* This file is generated from ../tokens/renderer-theme.json. Do not edit it directly. */
export const nativeThemeDimensions = {
  control: {
    compact: 40,
    icon: 40,
    large: 52,
    regular: 48,
    row: 60
  },
  radius: {
    large: 18,
    medium: 12,
    small: 8
  },
  space: {
    large: 24,
    medium: 16,
    small: 10,
    xlarge: 32
  }
} as const;

export const nativeThemes = {
  light: {
    accent: "#4182f5",
    accentPressed: "#3975df",
    background: "#f7f8fa",
    backgroundFronted: "#ffffff",
    backgroundPanel: "#f8fafc",
    border: "#e5e7eb",
    danger: "#dc2626",
    foreground: "#29313d",
    muted: "#6b7280",
    panel: "#f8f8fa",
    scrim: "rgba(0, 0, 0, 0.6)",
    scrimStrong: "rgba(0, 0, 0, 0.64)",
    success: "#22c55e",
    textPrimary: "#3c3c3c",
    textSecondary: "#6c6c6c"
  },
  dark: {
    accent: "#ff6b4a",
    accentPressed: "#eb5839",
    background: "#111216",
    backgroundFronted: "#22252d",
    backgroundPanel: "#1a1c22",
    border: "#30333b",
    danger: "#ff716c",
    foreground: "#f6f6f7",
    muted: "#9398a5",
    panel: "#1a1c22",
    scrim: "rgba(0, 0, 0, 0.6)",
    scrimStrong: "rgba(0, 0, 0, 0.64)",
    success: "#62d49f",
    textPrimary: "#f6f6f7",
    textSecondary: "#c3c6ce"
  }
} as const;

export type NativeThemeMode = keyof typeof nativeThemes;
export type NativeThemePalette = (typeof nativeThemes)[NativeThemeMode];
