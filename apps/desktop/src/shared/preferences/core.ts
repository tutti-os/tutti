export const desktopDockPlacements = ["bottom", "left"] as const;

export type DesktopDockPlacement = (typeof desktopDockPlacements)[number];

export const defaultDesktopDockPlacement: DesktopDockPlacement = "bottom";

export const desktopDockIconStyles = ["default", "flat"] as const;

export type DesktopDockIconStyle = (typeof desktopDockIconStyles)[number];

export const defaultDesktopDockIconStyle: DesktopDockIconStyle = "default";

export function readInitialDockPlacementFromLocation(
  locationSearch?: string
): DesktopDockPlacement {
  if (typeof window === "undefined" && locationSearch === undefined) {
    return defaultDesktopDockPlacement;
  }

  const value = new URLSearchParams(
    locationSearch ?? window.location.search
  ).get("dockPlacement");
  return isDesktopDockPlacement(value) ? value : defaultDesktopDockPlacement;
}

export function isDesktopDockPlacement(
  value: unknown
): value is DesktopDockPlacement {
  return (
    typeof value === "string" &&
    desktopDockPlacements.includes(value as DesktopDockPlacement)
  );
}

export function isDesktopDockIconStyle(
  value: unknown
): value is DesktopDockIconStyle {
  return (
    typeof value === "string" &&
    desktopDockIconStyles.includes(value as DesktopDockIconStyle)
  );
}

export const desktopAgentProviders = [
  "claude-code",
  "codex",
  "nexight",
  "gemini",
  "hermes",
  "openclaw"
] as const;

export type DesktopAgentProvider = (typeof desktopAgentProviders)[number];

export const defaultDesktopAgentProvider: DesktopAgentProvider = "codex";

export interface DesktopAgentComposerDefaults {
  model?: string;
  permissionModeId?: string;
  reasoningEffort?: string;
}

export type DesktopAgentComposerDefaultsByProvider = Partial<
  Record<DesktopAgentProvider, DesktopAgentComposerDefaults>
>;

export const desktopSleepPreventionModes = [
  "never",
  "whileAgentRunning",
  "always"
] as const;

export type DesktopSleepPreventionMode =
  (typeof desktopSleepPreventionModes)[number];

export const defaultDesktopSleepPreventionMode: DesktopSleepPreventionMode =
  "never";

export const desktopUpdatePolicies = ["off", "prompt", "auto"] as const;

export type DesktopUpdatePolicy = (typeof desktopUpdatePolicies)[number];

export const defaultDesktopUpdatePolicy: DesktopUpdatePolicy = "prompt";

export const desktopUpdateChannels = ["stable", "rc"] as const;

export type DesktopUpdateChannel = (typeof desktopUpdateChannels)[number];

export const defaultDesktopUpdateChannel: DesktopUpdateChannel = "rc";

export function isDesktopSleepPreventionMode(
  value: unknown
): value is DesktopSleepPreventionMode {
  return (
    typeof value === "string" &&
    desktopSleepPreventionModes.includes(value as DesktopSleepPreventionMode)
  );
}

export function isDesktopUpdatePolicy(
  value: unknown
): value is DesktopUpdatePolicy {
  return (
    typeof value === "string" &&
    desktopUpdatePolicies.includes(value as DesktopUpdatePolicy)
  );
}

export function isDesktopUpdateChannel(
  value: unknown
): value is DesktopUpdateChannel {
  return (
    typeof value === "string" &&
    desktopUpdateChannels.includes(value as DesktopUpdateChannel)
  );
}

export function isDesktopAgentProvider(
  value: unknown
): value is DesktopAgentProvider {
  return (
    typeof value === "string" &&
    desktopAgentProviders.includes(value as DesktopAgentProvider)
  );
}

export function normalizeDesktopAgentComposerDefaults(
  value: unknown
): DesktopAgentComposerDefaults | null {
  if (!isRecord(value)) {
    return null;
  }

  const defaults: DesktopAgentComposerDefaults = {};
  const model = normalizeOptionalText(value.model);
  const permissionModeId = normalizeOptionalText(value.permissionModeId);
  const reasoningEffort = normalizeOptionalText(value.reasoningEffort);
  if (model) {
    defaults.model = model;
  }
  if (permissionModeId) {
    defaults.permissionModeId = permissionModeId;
  }
  if (reasoningEffort) {
    defaults.reasoningEffort = reasoningEffort;
  }
  return Object.keys(defaults).length > 0 ? defaults : null;
}

export function normalizeDesktopAgentComposerDefaultsByProvider(
  value: unknown
): DesktopAgentComposerDefaultsByProvider {
  if (!isRecord(value)) {
    return {};
  }

  const defaultsByProvider: DesktopAgentComposerDefaultsByProvider = {};
  for (const provider of desktopAgentProviders) {
    const defaults = normalizeDesktopAgentComposerDefaults(value[provider]);
    if (defaults) {
      defaultsByProvider[provider] = defaults;
    }
  }
  return defaultsByProvider;
}

export function mergeDesktopAgentComposerDefaultsByProvider(
  current: DesktopAgentComposerDefaultsByProvider | null | undefined,
  provider: DesktopAgentProvider,
  defaults: DesktopAgentComposerDefaults | null | undefined
): DesktopAgentComposerDefaultsByProvider {
  const normalizedCurrent =
    normalizeDesktopAgentComposerDefaultsByProvider(current);
  const normalizedDefaults = normalizeDesktopAgentComposerDefaults(defaults);
  if (!normalizedDefaults) {
    const { [provider]: _removed, ...remaining } = normalizedCurrent;
    return remaining;
  }
  return {
    ...normalizedCurrent,
    [provider]: normalizedDefaults
  };
}

export function desktopAgentComposerDefaultsByProviderEqual(
  left: DesktopAgentComposerDefaultsByProvider | null | undefined,
  right: DesktopAgentComposerDefaultsByProvider | null | undefined
): boolean {
  const normalizedLeft = normalizeDesktopAgentComposerDefaultsByProvider(left);
  const normalizedRight =
    normalizeDesktopAgentComposerDefaultsByProvider(right);
  return desktopAgentProviders.every((provider) =>
    desktopAgentComposerDefaultsEqual(
      normalizedLeft[provider],
      normalizedRight[provider]
    )
  );
}

export function desktopAgentComposerDefaultsEqual(
  left: DesktopAgentComposerDefaults | null | undefined,
  right: DesktopAgentComposerDefaults | null | undefined
): boolean {
  const normalizedLeft = normalizeDesktopAgentComposerDefaults(left);
  const normalizedRight = normalizeDesktopAgentComposerDefaults(right);
  return (
    (normalizedLeft?.model ?? null) === (normalizedRight?.model ?? null) &&
    (normalizedLeft?.permissionModeId ?? null) ===
      (normalizedRight?.permissionModeId ?? null) &&
    (normalizedLeft?.reasoningEffort ?? null) ===
      (normalizedRight?.reasoningEffort ?? null)
  );
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
