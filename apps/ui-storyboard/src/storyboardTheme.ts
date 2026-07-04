import type { CSSProperties } from "react";

export const storyboardFontEnglish =
  '"Lexend Variable", "Lexend", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';

export const storyboardFontCjk =
  '"PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", system-ui, sans-serif';

export const storyboardFontMono =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export type StoryboardThemeMode = "light" | "dark";

const storyboardBaseThemeVars = {
  "--storyboard-font-english": storyboardFontEnglish,
  "--storyboard-font-cjk": storyboardFontCjk,
  "--font-ui": `${storyboardFontEnglish}, ${storyboardFontCjk}`,
  "--font-display": `var(--font-ui)`,
  "--font-sans-system": `var(--font-ui)`,
  "--font-mono": storyboardFontMono
} as const;

const storyboardLightThemeVars = {
  "--background-1": "rgb(244, 245, 247)",
  "--storyboard-canvas": "rgb(233, 229, 218)",
  "--storyboard-ink": "rgb(26, 26, 26)",
  "--background-panel": "rgb(248, 250, 252)",
  "--background-session-flow": "rgb(252, 253, 255)",
  "--background-session-sidepanel": "rgb(244, 245, 247)",
  "--background-fronted": "rgb(255, 255, 255)",
  "--text-primary": "rgb(60, 60, 60)",
  "--text-primary-hover": "rgba(60, 60, 60, 0.9)",
  "--text-secondary": "rgba(60, 60, 60, 0.7)",
  "--text-tertiary": "rgba(60, 60, 60, 0.5)",
  "--text-placeholder": "rgba(60, 60, 60, 0.3)",
  "--text-disabled": "rgba(60, 60, 60, 0.3)",
  "--text-inverted": "rgb(255, 255, 255)",
  "--white-stationary": "rgb(255, 255, 255)",
  "--black-stationary": "rgb(0, 0, 0)",
  "--border-1": "rgba(60, 60, 60, 0.08)",
  "--border-2": "rgba(60, 60, 60, 0.08)",
  "--line-1": "var(--border-1)",
  "--line-2": "var(--border-2)",
  "--border-focus": "rgba(65, 130, 245, 0.24)",
  "--accent-codex": "rgb(65, 130, 245)",
  "--accent": "var(--accent-codex)",
  "--accent-codex-border":
    "color-mix(in srgb, var(--accent-codex) 20%, transparent)",
  "--status-running": "rgb(65, 130, 245)",
  "--tutti-purple": "rgb(109, 127, 245)",
  "--tutti-purple-bg":
    "color-mix(in srgb, var(--background-fronted) 88%, var(--tutti-purple) 12%)",
  "--tutti-purple-border":
    "color-mix(in srgb, var(--tutti-purple) 20%, transparent)",
  "--accent-claude": "rgb(251, 111, 62)",
  "--accent-bg":
    "color-mix(in srgb, var(--background-fronted) 88%, var(--accent-codex) 12%)",
  "--shadow-elevated": "rgba(0, 0, 0, 0.08)",
  "--transparency-block": "rgba(60, 60, 60, 0.04)",
  "--transparency-hover": "rgba(60, 60, 60, 0.06)",
  "--transparency-active": "rgba(60, 60, 60, 0.06)",
  "--state-danger": "rgb(220, 38, 38)",
  "--state-danger-hover":
    "color-mix(in srgb, var(--state-danger) 90%, transparent)",
  "--state-success": "rgb(34, 197, 94)",
  "--on-danger": "rgb(255, 238, 242)",
  "--on-danger-hover":
    "color-mix(in srgb, var(--on-danger) 92%, var(--state-danger))",
  "--backdrop": "rgba(0, 0, 0, 0.60)",
  "--backdrop-dark": "rgba(0, 0, 0, 0.60)",
  "--rich-text-mention-app": "rgb(191, 90, 242)",
  "--rich-text-mention-issue": "var(--tutti-purple)",
  "--rich-text-mention-session": "rgb(34, 197, 94)",
  "--folder": "rgb(80, 175, 238)",
  "--rich-text-folder": "rgb(80, 175, 238)",
  "--rich-text-mention-file": "rgb(80, 175, 238)"
} as const;

const storyboardDarkThemeVars = {
  "--background-1": "rgb(24, 24, 24)",
  "--storyboard-canvas": "rgb(30, 30, 29)",
  "--storyboard-ink": "rgb(255, 255, 255)",
  "--background-panel": "rgb(42, 42, 43)",
  "--background-session-flow": "rgb(24, 24, 24)",
  "--background-session-sidepanel": "rgb(42, 42, 43)",
  "--background-fronted": "rgb(51, 51, 51)",
  "--text-primary": "rgb(255, 255, 255)",
  "--text-primary-hover": "rgba(255, 255, 255, 0.9)",
  "--text-secondary": "rgba(255, 255, 255, 0.7)",
  "--text-tertiary": "rgba(255, 255, 255, 0.5)",
  "--text-placeholder": "rgba(255, 255, 255, 0.3)",
  "--text-disabled": "rgba(255, 255, 255, 0.3)",
  "--text-inverted": "rgb(60, 60, 60)",
  "--white-stationary": "rgb(255, 255, 255)",
  "--black-stationary": "rgb(0, 0, 0)",
  "--border-1": "rgba(255, 255, 255, 0.12)",
  "--border-2": "rgba(255, 255, 255, 0.08)",
  "--line-1": "var(--border-1)",
  "--line-2": "var(--border-2)",
  "--border-focus": "rgba(79, 143, 255, 0.24)",
  "--accent-codex": "rgb(79, 143, 255)",
  "--accent": "var(--accent-codex)",
  "--accent-codex-border":
    "color-mix(in srgb, var(--accent-codex) 20%, transparent)",
  "--status-running": "rgb(79, 143, 255)",
  "--tutti-purple": "rgb(136, 152, 255)",
  "--tutti-purple-bg":
    "color-mix(in srgb, var(--background-fronted) 88%, var(--tutti-purple) 12%)",
  "--tutti-purple-border":
    "color-mix(in srgb, var(--tutti-purple) 20%, transparent)",
  "--accent-claude": "rgb(251, 111, 62)",
  "--accent-bg":
    "color-mix(in srgb, var(--background-fronted) 88%, var(--accent-codex) 12%)",
  "--shadow-elevated": "rgba(0, 0, 0, 0.5)",
  "--transparency-block": "rgba(255, 255, 255, 0.1)",
  "--transparency-hover": "rgba(255, 255, 255, 0.14)",
  "--transparency-active": "rgba(255, 255, 255, 0.16)",
  "--state-danger": "rgb(244, 91, 91)",
  "--state-danger-hover":
    "color-mix(in srgb, var(--state-danger) 90%, transparent)",
  "--state-success": "rgb(74, 222, 128)",
  "--on-danger": "rgba(248, 113, 113, 0.10)",
  "--on-danger-hover":
    "color-mix(in srgb, var(--on-danger) 82%, var(--state-danger))",
  "--backdrop": "rgba(0, 0, 0, 0.60)",
  "--backdrop-dark": "rgba(0, 0, 0, 0.60)",
  "--rich-text-mention-app": "rgb(191, 90, 242)",
  "--rich-text-mention-issue": "var(--tutti-purple)",
  "--rich-text-mention-session": "rgb(74, 222, 128)",
  "--folder": "rgb(80, 175, 238)",
  "--rich-text-folder": "rgb(80, 175, 238)",
  "--rich-text-mention-file": "rgb(80, 175, 238)"
} as const;

export function getStoryboardThemeVars(mode: StoryboardThemeMode) {
  return {
    ...storyboardBaseThemeVars,
    ...(mode === "dark" ? storyboardDarkThemeVars : storyboardLightThemeVars)
  } as CSSProperties;
}

export const storyboardThemeVars = {
  ...storyboardBaseThemeVars,
  ...storyboardLightThemeVars
} as CSSProperties;
