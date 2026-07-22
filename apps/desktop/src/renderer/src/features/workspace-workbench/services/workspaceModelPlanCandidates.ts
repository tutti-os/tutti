import type { WorkspaceModelPlanModel } from "./workspaceSettingsTypes.ts";

/**
 * Builds the read-only model catalog used by the picker. Discovery data wins
 * over preset hints because it can carry current pricing and capabilities.
 */
export function buildWorkspaceModelPlanCandidateCatalog(
  presetModels: readonly WorkspaceModelPlanModel[],
  discoveredModels: readonly WorkspaceModelPlanModel[]
): WorkspaceModelPlanModel[] {
  const byID = new Map<string, WorkspaceModelPlanModel>();
  for (const model of [...presetModels, ...discoveredModels]) {
    const id = model.id.trim();
    if (!id) {
      continue;
    }
    byID.set(id, { ...model, id, name: model.name.trim() || id });
  }
  return [...byID.values()];
}

/** Excludes ids owned by sibling slots while keeping the current selection. */
export function workspaceModelPlanCandidatesForSlot(
  catalog: readonly WorkspaceModelPlanModel[],
  selectedModels: readonly WorkspaceModelPlanModel[],
  slotIndex: number
): WorkspaceModelPlanModel[] {
  const selectedElsewhere = new Set(
    selectedModels
      .filter((_, index) => index !== slotIndex)
      .map((model) => model.id.trim())
      .filter(Boolean)
  );
  return catalog.filter((model) => !selectedElsewhere.has(model.id));
}

/** Custom ids intentionally start clean so metadata cannot leak across slots. */
export function createCustomWorkspaceModelPlanCandidate(
  rawID: string
): WorkspaceModelPlanModel | null {
  const id = rawID.trim();
  return id ? { id, name: id } : null;
}
