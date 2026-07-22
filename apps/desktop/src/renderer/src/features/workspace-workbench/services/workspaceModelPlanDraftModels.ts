import type { WorkspaceModelPlanModel } from "./workspaceSettingsTypes.ts";

export interface WorkspaceModelPlanDraftModelSelection {
  readonly defaultModel: string;
  readonly models: readonly WorkspaceModelPlanModel[];
}

interface ReplaceWorkspaceModelPlanDraftModelInput extends WorkspaceModelPlanDraftModelSelection {
  readonly index: number;
  readonly model: WorkspaceModelPlanModel;
}

interface RemoveWorkspaceModelPlanDraftModelInput extends WorkspaceModelPlanDraftModelSelection {
  readonly index: number;
}

interface ReconcileWorkspaceModelPlanDraftModelsForPresetInput extends WorkspaceModelPlanDraftModelSelection {
  readonly presetModels: readonly WorkspaceModelPlanModel[];
}

/** A visible editor slot is not a model selection until it has a non-empty id. */
export function createEmptyWorkspaceModelPlanDraftModel(): WorkspaceModelPlanModel {
  return { id: "", name: "" };
}

/**
 * Replaces one editor slot with the complete catalog model. Replacing the
 * object rather than patching its id prevents stale pricing, tier, or
 * capabilities from leaking from the previous selection. An id already owned
 * by a sibling slot is rejected so two slots can never share one model.
 */
export function replaceWorkspaceModelPlanDraftModel(
  input: ReplaceWorkspaceModelPlanDraftModelInput
): WorkspaceModelPlanDraftModelSelection {
  const models = input.models.map(cloneWorkspaceModelPlanModel);
  const nextID = input.model.id.trim();
  const ownedBySibling =
    nextID.length > 0 &&
    input.models.some(
      (model, index) => index !== input.index && model.id.trim() === nextID
    );
  if (!ownedBySibling && input.index >= 0 && input.index < models.length) {
    models[input.index] = cloneWorkspaceModelPlanModel(input.model);
  }
  return repairWorkspaceModelPlanDraftDefault(models, input.defaultModel);
}

/** Removes one slot and repairs a removed or otherwise invalid default. */
export function removeWorkspaceModelPlanDraftModel(
  input: RemoveWorkspaceModelPlanDraftModelInput
): WorkspaceModelPlanDraftModelSelection {
  const models = input.models
    .filter((_, index) => index !== input.index)
    .map(cloneWorkspaceModelPlanModel);
  return repairWorkspaceModelPlanDraftDefault(models, input.defaultModel);
}

/**
 * Keeps only explicit selections supported by the next preset. Catalog-only
 * models are never promoted into the draft. Matching preset objects replace
 * old selections so their metadata cannot remain stale after the switch.
 */
export function reconcileWorkspaceModelPlanDraftModelsForPreset(
  input: ReconcileWorkspaceModelPlanDraftModelsForPresetInput
): WorkspaceModelPlanDraftModelSelection {
  const presetModelsByID = new Map(
    input.presetModels
      .map((model) => [model.id.trim(), model] as const)
      .filter(([id]) => id.length > 0)
  );
  const seen = new Set<string>();
  const models: WorkspaceModelPlanModel[] = [];
  for (const selected of input.models) {
    const id = selected.id.trim();
    const presetModel = presetModelsByID.get(id);
    if (!presetModel || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push(cloneWorkspaceModelPlanModel(presetModel));
  }
  if (models.length === 0) {
    models.push(createEmptyWorkspaceModelPlanDraftModel());
  }
  return repairWorkspaceModelPlanDraftDefault(models, input.defaultModel);
}

/**
 * Retains a valid explicit default; otherwise chooses the first selected
 * model. Blank slots never become a default.
 */
export function repairWorkspaceModelPlanDraftDefault(
  models: readonly WorkspaceModelPlanModel[],
  defaultModel: string
): WorkspaceModelPlanDraftModelSelection {
  const selectedIDs = models.map((model) => model.id.trim()).filter(Boolean);
  const requestedDefault = defaultModel.trim();
  return {
    defaultModel: selectedIDs.includes(requestedDefault)
      ? requestedDefault
      : (selectedIDs[0] ?? ""),
    models
  };
}

function cloneWorkspaceModelPlanModel(
  model: WorkspaceModelPlanModel
): WorkspaceModelPlanModel {
  return {
    ...model,
    ...(model.capabilities !== undefined
      ? {
          capabilities:
            model.capabilities === null ? null : [...model.capabilities]
        }
      : {}),
    ...(model.pricing ? { pricing: { ...model.pricing } } : {})
  };
}
