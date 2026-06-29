import type { DesktopAgentComposerDefaults } from "@shared/preferences";
import type { DesktopAgentGUIComposerOverrides } from "../../desktopAgentGUINodeState.ts";

export function desktopAgentComposerOverridesToDefaults(
  overrides: DesktopAgentGUIComposerOverrides
): DesktopAgentComposerDefaults | null {
  const defaults: DesktopAgentComposerDefaults = {};
  if (overrides.model?.trim()) {
    defaults.model = overrides.model.trim();
  }
  if (overrides.permissionModeId?.trim()) {
    defaults.permissionModeId = overrides.permissionModeId.trim();
  }
  if (overrides.reasoningEffort?.trim()) {
    defaults.reasoningEffort = overrides.reasoningEffort.trim();
  }
  return Object.keys(defaults).length > 0 ? defaults : null;
}

export function desktopAgentComposerDefaultsEqual(
  left: DesktopAgentComposerDefaults | null | undefined,
  right: DesktopAgentComposerDefaults | null | undefined
): boolean {
  return (
    normalizedDesktopAgentComposerDefaultValue(left?.model) ===
      normalizedDesktopAgentComposerDefaultValue(right?.model) &&
    normalizedDesktopAgentComposerDefaultValue(left?.permissionModeId) ===
      normalizedDesktopAgentComposerDefaultValue(right?.permissionModeId) &&
    normalizedDesktopAgentComposerDefaultValue(left?.reasoningEffort) ===
      normalizedDesktopAgentComposerDefaultValue(right?.reasoningEffort)
  );
}

export function normalizedDesktopAgentComposerDefaultValue(
  value: string | null | undefined
): string {
  return value?.trim() ?? "";
}
