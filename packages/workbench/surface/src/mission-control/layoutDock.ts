import type { WorkbenchLayoutPreset } from "../core/types.ts";

export function shouldShowWorkbenchMissionControlLayoutHint(
  selectedCount: number
): boolean {
  return selectedCount < 2;
}

export function shouldShowWorkbenchMissionControlNoAvailableLayoutMessage(
  selectedCount: number,
  hasUsablePreset: boolean
): boolean {
  return selectedCount >= 2 && !hasUsablePreset;
}

export function shouldShowWorkbenchMissionControlLayoutPreset(
  selectedCount: number,
  preset: WorkbenchLayoutPreset
): boolean {
  if (selectedCount === 2) {
    return preset.kind !== "balanced";
  }

  if (selectedCount >= 4) {
    return preset.kind === "balanced";
  }

  return true;
}
