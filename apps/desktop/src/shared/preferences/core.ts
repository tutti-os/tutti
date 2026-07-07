export const desktopDockPlacements = ["bottom", "left"] as const;

export type DesktopDockPlacement = (typeof desktopDockPlacements)[number];

export const defaultDesktopDockPlacement: DesktopDockPlacement = "bottom";

export const desktopDockIconStyles = ["default", "flat"] as const;

export type DesktopDockIconStyle = (typeof desktopDockIconStyles)[number];

export const defaultDesktopDockIconStyle: DesktopDockIconStyle = "default";

export const desktopMinimizeAnimations = ["scale", "genie", "off"] as const;

export type DesktopMinimizeAnimation =
  (typeof desktopMinimizeAnimations)[number];

export const defaultDesktopMinimizeAnimation: DesktopMinimizeAnimation =
  "genie";

export const desktopWorkbenchWindowSnappingShortcutPresets = [
  "commandArrows",
  "commandShiftArrows"
] as const;

export type DesktopWorkbenchWindowSnappingShortcutPreset =
  (typeof desktopWorkbenchWindowSnappingShortcutPresets)[number];

export interface DesktopWorkbenchWindowSnapping {
  enabled: boolean;
  shortcutPreset: DesktopWorkbenchWindowSnappingShortcutPreset;
}

export const defaultDesktopWorkbenchWindowSnapping: DesktopWorkbenchWindowSnapping =
  {
    enabled: false,
    shortcutPreset: "commandArrows"
  };

export const desktopBrowserUseConnectionModes = [
  "isolated",
  "autoConnect"
] as const;

export type DesktopBrowserUseConnectionMode =
  (typeof desktopBrowserUseConnectionModes)[number];

export const defaultDesktopBrowserUseConnectionMode: DesktopBrowserUseConnectionMode =
  "isolated";

export const desktopAppCatalogChannels = ["production", "staging"] as const;

export type DesktopAppCatalogChannel =
  (typeof desktopAppCatalogChannels)[number];

export const defaultDesktopAppCatalogChannel: DesktopAppCatalogChannel =
  "production";

export const defaultDesktopShowAppDeveloperSources = false;

export const defaultDesktopEnableCursorAgent = false;

export const defaultDesktopEnableOpenCodeAgent = false;

export const desktopAgentConversationDetailModes = [
  "coding",
  "general"
] as const;

export type DesktopAgentConversationDetailMode =
  (typeof desktopAgentConversationDetailModes)[number];

export const defaultDesktopAgentConversationDetailMode: DesktopAgentConversationDetailMode =
  "coding";

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

export function isDesktopMinimizeAnimation(
  value: unknown
): value is DesktopMinimizeAnimation {
  return (
    typeof value === "string" &&
    desktopMinimizeAnimations.includes(value as DesktopMinimizeAnimation)
  );
}

export function isDesktopWorkbenchWindowSnappingShortcutPreset(
  value: unknown
): value is DesktopWorkbenchWindowSnappingShortcutPreset {
  return (
    typeof value === "string" &&
    desktopWorkbenchWindowSnappingShortcutPresets.includes(
      value as DesktopWorkbenchWindowSnappingShortcutPreset
    )
  );
}

export function isDesktopBrowserUseConnectionMode(
  value: unknown
): value is DesktopBrowserUseConnectionMode {
  return (
    typeof value === "string" &&
    desktopBrowserUseConnectionModes.includes(
      value as DesktopBrowserUseConnectionMode
    )
  );
}

export function isDesktopAppCatalogChannel(
  value: unknown
): value is DesktopAppCatalogChannel {
  return (
    typeof value === "string" &&
    desktopAppCatalogChannels.includes(value as DesktopAppCatalogChannel)
  );
}

export function isDesktopAgentConversationDetailMode(
  value: unknown
): value is DesktopAgentConversationDetailMode {
  return (
    typeof value === "string" &&
    desktopAgentConversationDetailModes.includes(
      value as DesktopAgentConversationDetailMode
    )
  );
}

export function normalizeDesktopAgentConversationDetailMode(
  value: unknown
): DesktopAgentConversationDetailMode {
  return isDesktopAgentConversationDetailMode(value)
    ? value
    : defaultDesktopAgentConversationDetailMode;
}

export const desktopAgentProviders = [
  "claude-code",
  "codex",
  "tutti-agent",
  "cursor",
  "nexight",
  "gemini",
  "hermes",
  "openclaw",
  "opencode"
] as const;

export type DesktopAgentProvider = (typeof desktopAgentProviders)[number];

export const desktopDefaultAgentProviders = ["claude-code", "codex"] as const;

export type DesktopDefaultAgentProvider =
  (typeof desktopDefaultAgentProviders)[number];

export const defaultDesktopAgentProvider: DesktopDefaultAgentProvider = "codex";

export interface DesktopAgentComposerDefaults {
  model?: string;
  permissionModeId?: string;
  reasoningEffort?: string;
  speed?: string;
}

export type DesktopAgentComposerDefaultsByProvider = Partial<
  Record<DesktopAgentProvider, DesktopAgentComposerDefaults>
>;

export type DesktopAgentComposerDefaultsByAgentTarget = Record<
  string,
  DesktopAgentComposerDefaults
>;

// Patch for one agent target's remembered defaults: undefined leaves a field
// untouched, null (or empty) clears it, a non-empty string replaces it.
export interface DesktopAgentComposerDefaultsPatch {
  model?: string | null;
  permissionModeId?: string | null;
  reasoningEffort?: string | null;
  speed?: string | null;
}

export const desktopAgentComposerDefaultsFields = [
  "model",
  "permissionModeId",
  "reasoningEffort",
  "speed"
] as const;

export type DesktopAgentGuiConversationRailCollapsedByProvider = Partial<
  Record<DesktopAgentProvider, boolean>
>;

export const desktopFileDefaultOpeners = [
  "appBrowser",
  "defaultBrowser",
  "fileViewer",
  "system"
] as const;

export type DesktopFileDefaultOpener =
  (typeof desktopFileDefaultOpeners)[number];

export type DesktopFileDefaultOpenersByExtension = Record<
  string,
  DesktopFileDefaultOpener
>;

export const defaultDesktopFileDefaultOpenersByExtension: DesktopFileDefaultOpenersByExtension =
  {
    htm: "appBrowser",
    html: "appBrowser",
    shtml: "appBrowser",
    xhtml: "appBrowser"
  };

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

export const defaultDesktopUpdateChannel: DesktopUpdateChannel = "stable";

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

export function isDesktopDefaultAgentProvider(
  value: unknown
): value is DesktopDefaultAgentProvider {
  return (
    typeof value === "string" &&
    desktopDefaultAgentProviders.includes(value as DesktopDefaultAgentProvider)
  );
}

export function isDesktopFileDefaultOpener(
  value: unknown
): value is DesktopFileDefaultOpener {
  return (
    typeof value === "string" &&
    desktopFileDefaultOpeners.includes(value as DesktopFileDefaultOpener)
  );
}

export function normalizeDesktopWorkbenchWindowSnapping(
  value: unknown
): DesktopWorkbenchWindowSnapping {
  if (!isRecord(value)) {
    return { ...defaultDesktopWorkbenchWindowSnapping };
  }
  return {
    enabled: value.enabled === true,
    shortcutPreset: isDesktopWorkbenchWindowSnappingShortcutPreset(
      value.shortcutPreset
    )
      ? value.shortcutPreset
      : defaultDesktopWorkbenchWindowSnapping.shortcutPreset
  };
}

export function desktopWorkbenchWindowSnappingEqual(
  left: DesktopWorkbenchWindowSnapping | null | undefined,
  right: DesktopWorkbenchWindowSnapping | null | undefined
): boolean {
  const normalizedLeft = normalizeDesktopWorkbenchWindowSnapping(left);
  const normalizedRight = normalizeDesktopWorkbenchWindowSnapping(right);
  return (
    normalizedLeft.enabled === normalizedRight.enabled &&
    normalizedLeft.shortcutPreset === normalizedRight.shortcutPreset
  );
}

export function normalizeDesktopFileExtension(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/^\.+/u, "");
  return /^[a-z0-9][a-z0-9_-]{0,31}$/u.test(normalized) ? normalized : null;
}

export function normalizeDesktopFileDefaultOpenersByExtension(
  value: unknown
): DesktopFileDefaultOpenersByExtension {
  if (!isRecord(value)) {
    return { ...defaultDesktopFileDefaultOpenersByExtension };
  }

  const result: DesktopFileDefaultOpenersByExtension = {};
  for (const [extension, opener] of Object.entries(value)) {
    const normalizedExtension = normalizeDesktopFileExtension(extension);
    if (!normalizedExtension || !isDesktopFileDefaultOpener(opener)) {
      continue;
    }
    result[normalizedExtension] = opener;
  }
  return result;
}

export function desktopFileDefaultOpenersByExtensionEqual(
  left: DesktopFileDefaultOpenersByExtension | null | undefined,
  right: DesktopFileDefaultOpenersByExtension | null | undefined
): boolean {
  const normalizedLeft = normalizeDesktopFileDefaultOpenersByExtension(left);
  const normalizedRight = normalizeDesktopFileDefaultOpenersByExtension(right);
  const keys = new Set([
    ...Object.keys(normalizedLeft),
    ...Object.keys(normalizedRight)
  ]);
  for (const key of keys) {
    if (normalizedLeft[key] !== normalizedRight[key]) {
      return false;
    }
  }
  return true;
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
  const speed = normalizeOptionalText(value.speed);
  if (model) {
    defaults.model = model;
  }
  if (permissionModeId) {
    defaults.permissionModeId = permissionModeId;
  }
  if (reasoningEffort) {
    defaults.reasoningEffort = reasoningEffort;
  }
  if (speed) {
    defaults.speed = speed;
  }
  return Object.keys(defaults).length > 0 ? defaults : null;
}

export function normalizeDesktopAgentComposerDefaultsByAgentTarget(
  value: unknown
): DesktopAgentComposerDefaultsByAgentTarget {
  if (!isRecord(value)) {
    return {};
  }

  const defaultsByAgentTarget: DesktopAgentComposerDefaultsByAgentTarget = {};
  for (const [agentTargetId, entry] of Object.entries(value)) {
    const normalizedAgentTargetId = normalizeOptionalText(agentTargetId);
    if (!normalizedAgentTargetId) {
      continue;
    }
    const defaults = normalizeDesktopAgentComposerDefaults(entry);
    if (defaults) {
      defaultsByAgentTarget[normalizedAgentTargetId] = defaults;
    }
  }
  return defaultsByAgentTarget;
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

export function normalizeDesktopAgentGuiConversationRailCollapsedByProvider(
  value: unknown
): DesktopAgentGuiConversationRailCollapsedByProvider {
  if (!isRecord(value)) {
    return {};
  }

  const collapsedByProvider: DesktopAgentGuiConversationRailCollapsedByProvider =
    {};
  for (const provider of desktopAgentProviders) {
    if (typeof value[provider] === "boolean") {
      collapsedByProvider[provider] = value[provider];
    }
  }
  return collapsedByProvider;
}

export function mergeDesktopAgentGuiConversationRailCollapsedByProvider(
  current:
    | DesktopAgentGuiConversationRailCollapsedByProvider
    | null
    | undefined,
  provider: DesktopAgentProvider,
  collapsed: boolean
): DesktopAgentGuiConversationRailCollapsedByProvider {
  return {
    ...normalizeDesktopAgentGuiConversationRailCollapsedByProvider(current),
    [provider]: collapsed
  };
}

export function desktopAgentGuiConversationRailCollapsedByProviderEqual(
  left: DesktopAgentGuiConversationRailCollapsedByProvider | null | undefined,
  right: DesktopAgentGuiConversationRailCollapsedByProvider | null | undefined
): boolean {
  const normalizedLeft =
    normalizeDesktopAgentGuiConversationRailCollapsedByProvider(left);
  const normalizedRight =
    normalizeDesktopAgentGuiConversationRailCollapsedByProvider(right);
  return desktopAgentProviders.every(
    (provider) =>
      (normalizedLeft[provider] ?? false) ===
      (normalizedRight[provider] ?? false)
  );
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

// Merges a patch into the existing entry: only the fields present in the
// patch change, so a partial user switch never clobbers other remembered
// fields. An explicit null (or empty) field clears the remembered value; a
// null patch removes the whole entry.
export function mergeDesktopAgentComposerDefaultsByAgentTarget(
  current: DesktopAgentComposerDefaultsByAgentTarget | null | undefined,
  agentTargetId: string,
  patch: DesktopAgentComposerDefaultsPatch | null | undefined
): DesktopAgentComposerDefaultsByAgentTarget {
  const normalizedCurrent =
    normalizeDesktopAgentComposerDefaultsByAgentTarget(current);
  const normalizedAgentTargetId = agentTargetId.trim();
  if (!normalizedAgentTargetId) {
    return normalizedCurrent;
  }
  const { [normalizedAgentTargetId]: existing, ...remaining } =
    normalizedCurrent;
  if (patch === null || patch === undefined) {
    return remaining;
  }
  const merged: DesktopAgentComposerDefaults = { ...existing };
  for (const field of desktopAgentComposerDefaultsFields) {
    const value = patch[field];
    if (value === undefined) {
      continue;
    }
    const normalizedValue = normalizeOptionalText(value);
    if (normalizedValue) {
      merged[field] = normalizedValue;
    } else {
      delete merged[field];
    }
  }
  if (Object.keys(merged).length === 0) {
    return remaining;
  }
  return {
    ...remaining,
    [normalizedAgentTargetId]: merged
  };
}

export function desktopAgentComposerDefaultsByAgentTargetEqual(
  left: DesktopAgentComposerDefaultsByAgentTarget | null | undefined,
  right: DesktopAgentComposerDefaultsByAgentTarget | null | undefined
): boolean {
  const normalizedLeft =
    normalizeDesktopAgentComposerDefaultsByAgentTarget(left);
  const normalizedRight =
    normalizeDesktopAgentComposerDefaultsByAgentTarget(right);
  const agentTargetIds = new Set([
    ...Object.keys(normalizedLeft),
    ...Object.keys(normalizedRight)
  ]);
  for (const agentTargetId of agentTargetIds) {
    if (
      !desktopAgentComposerDefaultsEqual(
        normalizedLeft[agentTargetId],
        normalizedRight[agentTargetId]
      )
    ) {
      return false;
    }
  }
  return true;
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
      (normalizedRight?.reasoningEffort ?? null) &&
    (normalizedLeft?.speed ?? null) === (normalizedRight?.speed ?? null)
  );
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
