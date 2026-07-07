import type { DesktopAgentComposerDefaults } from "@shared/preferences";

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
      normalizedDesktopAgentComposerDefaultValue(right?.reasoningEffort) &&
    normalizedDesktopAgentComposerDefaultValue(left?.speed) ===
      normalizedDesktopAgentComposerDefaultValue(right?.speed)
  );
}

export function normalizedDesktopAgentComposerDefaultValue(
  value: string | null | undefined
): string {
  return value?.trim() ?? "";
}
