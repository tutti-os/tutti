import type {
  WorkspaceModelPlan,
  WorkspaceModelPlanDetection,
  WorkspaceModelPlanDraft,
  WorkspaceModelPlanModel
} from "../workspaceSettingsTypes.ts";
import { workspaceModelPlanUsesNativeLogin } from "../workspaceModelPlanTemplates.ts";
import type { DetectModelPlanInput } from "./adapters/desktopWorkspaceSettingsClient.ts";

/**
 * Pure validation and request-assembly rules for one model-plan draft.
 * The controller owns state transitions; every predicate here is a plain
 * function of the draft so the save/detect gates stay independently testable.
 */

export function hasRequiredWorkspaceModelPlanDraftFields(
  draft: WorkspaceModelPlanDraft
): boolean {
  if (draft.name.trim().length === 0) {
    return false;
  }
  const models = normalizeWorkspaceModelPlanDraftModels(draft.models);
  if (workspaceModelPlanUsesNativeLogin(draft.templateKind)) {
    return draft.planId !== null || models.length > 0;
  }
  // Endpoint-backed plans must carry at least one explicit model: the daemon
  // can pass detection by probing a discovered candidate, but a saved plan
  // without models (and thus without a default) would be unusable.
  return (
    models.length > 0 &&
    draft.baseUrl.trim().length > 0 &&
    (draft.hasApiKey || draft.apiKey.trim().length > 0)
  );
}

/**
 * Assembles the daemon detect request for the draft, or null when an
 * endpoint draft is missing its Base URL. Native-login templates and saved
 * plans may detect without endpoint credentials.
 */
export function buildWorkspaceModelPlanDetectRequest(
  draft: WorkspaceModelPlanDraft
): DetectModelPlanInput | null {
  const baseUrl = draft.baseUrl.trim();
  const usesNativeLogin = workspaceModelPlanUsesNativeLogin(draft.templateKind);
  if (!baseUrl && !draft.planId && !usesNativeLogin) {
    return null;
  }
  const models = normalizeWorkspaceModelPlanDraftModels(draft.models);
  return {
    ...(draft.planId ? { planId: draft.planId } : {}),
    protocol: draft.protocol,
    ...(usesNativeLogin ? { templateKind: draft.templateKind } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
    ...(models.length > 0
      ? { models: models.map(({ id, name }) => ({ id, name })) }
      : {}),
    ...(draft.defaultModel.trim() ? { model: draft.defaultModel.trim() } : {})
  };
}

export function workspaceModelPlanConnectionChanged(
  draft: WorkspaceModelPlanDraft,
  stored: WorkspaceModelPlan | undefined
): boolean {
  if (!stored) {
    return true;
  }
  return (
    draft.apiKey.trim().length > 0 ||
    draft.baseUrl.trim() !== (stored.baseUrl ?? "").trim() ||
    draft.protocol !== stored.protocol
  );
}

export function workspaceModelPlanModelRangeChanged(
  draft: WorkspaceModelPlanDraft,
  stored: WorkspaceModelPlan | undefined
): boolean {
  if (!stored) {
    return false;
  }
  const draftIDs = normalizeWorkspaceModelPlanDraftModels(draft.models)
    .map((model) => model.id)
    .sort();
  const storedIDs = normalizeWorkspaceModelPlanDraftModels(stored.models)
    .map((model) => model.id)
    .sort();
  return (
    draftIDs.length !== storedIDs.length ||
    draftIDs.some((id, index) => id !== storedIDs[index])
  );
}

export function workspaceModelPlanDetectionCorePassed(
  detection: WorkspaceModelPlanDetection | null
): boolean {
  if (!detection) {
    return false;
  }
  const stages = ["network", "auth", "model_discovery", "inference"] as const;
  return stages.every((stage) => {
    const result = detection.stages.find(
      (candidate) => candidate.stage === stage
    );
    return result?.status === "passed" || result?.status === "skipped";
  });
}

export function normalizeWorkspaceModelPlanDraftModels(
  models: readonly WorkspaceModelPlanModel[]
): WorkspaceModelPlanModel[] {
  const seen = new Set<string>();
  const normalized: WorkspaceModelPlanModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push({
      ...(model.capabilities !== undefined
        ? { capabilities: model.capabilities }
        : {}),
      ...(model.pricing ? { pricing: { ...model.pricing } } : {}),
      id,
      name: model.name.trim() || id,
      tier:
        model.tier === "flagship" || model.tier === "economy"
          ? model.tier
          : "standard"
    });
  }
  return normalized;
}
