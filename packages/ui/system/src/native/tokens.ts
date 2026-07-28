import {
  nativeThemeDimensions,
  nativeThemes,
  type NativeThemeMode,
  type NativeThemePalette
} from "./generated-tokens";

export { nativeThemeDimensions, nativeThemes };
export type { NativeThemeMode, NativeThemePalette };

/**
 * Resolves a renderer-neutral semantic theme for React Native.
 */
export function resolveNativeTheme(mode: NativeThemeMode) {
  const palette = nativeThemes[mode];

  return {
    control: nativeThemeDimensions.control,
    color: {
      accent: palette.accent,
      accentPressed: palette.accentPressed,
      background: palette.background,
      border: palette.border,
      danger: palette.danger,
      muted: palette.muted,
      panel: palette.panel,
      panelRaised: palette.backgroundFronted,
      scrim: palette.scrim,
      scrimStrong: palette.scrimStrong,
      success: palette.success,
      text: palette.textPrimary,
      textSecondary: palette.textSecondary
    },
    mode,
    radius: nativeThemeDimensions.radius,
    space: nativeThemeDimensions.space
  } as const;
}

/**
 * Backwards-compatible dark Native theme.
 *
 * New components should consume the context-backed `useNativeTheme` hook so
 * they respond to the Native renderer's configured color scheme.
 */
export const nativeTheme = resolveNativeTheme("dark");

export type NativeTheme = typeof nativeTheme;
