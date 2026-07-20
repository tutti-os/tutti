import type { NotificationService } from "@tutti-os/ui-notifications";
import { createTranslator } from "../../../../../../shared/i18n/index.ts";
import { getActiveLocale } from "../../../../i18n/runtime.ts";
import type {
  IWorkspaceModelPlansController,
  WorkspaceAgentModelBindingChange
} from "../workspaceSettingsService.interface";
import type {
  WorkspaceModelPlan,
  WorkspaceModelPlanDraft,
  WorkspaceModelPlanDraftSeed,
  WorkspaceModelPlanFeedbackKind,
  WorkspaceModelPlanModel,
  WorkspaceSettingsStoreState
} from "../workspaceSettingsTypes.ts";
import type {
  DesktopWorkspaceSettingsClient,
  DetectModelPlanInput,
  PutModelPlanInput
} from "./adapters/desktopWorkspaceSettingsClient.ts";
import { isModelPlanReferencedError } from "./adapters/desktopWorkspaceSettingsClient.ts";
import { createWorkspaceSettingsModelPlansState } from "./workspaceSettingsStore.ts";

export interface WorkspaceModelPlansControllerDependencies {
  client: Pick<
    DesktopWorkspaceSettingsClient,
    | "createModelPlan"
    | "deleteModelPlan"
    | "detectModelPlan"
    | "duplicateModelPlan"
    | "listAgentModelBindings"
    | "listAgentTargets"
    | "listModelPlanReferences"
    | "listModelPlans"
    | "setAgentModelBinding"
    | "setModelPlanEnabled"
    | "updateModelPlan"
  >;
  notifications: NotificationService;
  store: WorkspaceSettingsStoreState;
}

/**
 * Owns the workspace "model plans" settings slice: named model access plans
 * with staged connection detection plus per-agent-target model bindings.
 * API keys only ever live inside the in-flight draft and request payloads.
 */
export class WorkspaceModelPlansController implements IWorkspaceModelPlansController {
  private readonly dependencies: WorkspaceModelPlansControllerDependencies;

  constructor(dependencies: WorkspaceModelPlansControllerDependencies) {
    this.dependencies = dependencies;
  }

  private get store() {
    return this.dependencies.store;
  }

  private get state() {
    return this.store.modelPlans;
  }

  reset(): void {
    this.store.modelPlans = createWorkspaceSettingsModelPlansState();
  }

  async refresh(): Promise<void> {
    await Promise.all([this.refreshPlans(), this.refreshBindings()]);
  }

  async refreshPlans(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.state.loading) {
      return;
    }
    this.state.loading = true;
    try {
      this.state.plans =
        await this.dependencies.client.listModelPlans(workspaceID);
    } catch {
      this.dependencies.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.apps.modelPlans.loadFailed"
        )
      });
    } finally {
      this.state.loading = false;
    }
  }

  async refreshBindings(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const bindings = this.state.bindings;
    if (!workspaceID || bindings.loading) {
      return;
    }
    bindings.loading = true;
    bindings.loadFailed = false;
    try {
      const [targets, targetBindings] = await Promise.all([
        this.dependencies.client.listAgentTargets(),
        this.dependencies.client.listAgentModelBindings(workspaceID)
      ]);
      bindings.agentTargets = targets
        .filter((target) => target.enabled)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((target) => ({
          enabled: target.enabled,
          id: target.id,
          name: target.name,
          provider: target.provider
        }));
      bindings.bindings = targetBindings;
    } catch {
      bindings.loadFailed = true;
    } finally {
      bindings.loading = false;
    }
  }

  beginDraft(seed: WorkspaceModelPlanDraftSeed): void {
    const models = normalizeModels(seed.models ?? []);
    this.setDraft({
      apiKey: "",
      baseUrl: seed.baseUrl ?? "",
      defaultModel: models[0]?.id ?? "",
      enabled: true,
      hasApiKey: false,
      models,
      name: seed.name ?? "",
      planId: null,
      protocol: seed.protocol,
      templateId: seed.templateId ?? null,
      templateKind: seed.templateKind
    });
  }

  beginEditPlan(planID: string): void {
    const plan = this.state.plans.find((candidate) => candidate.id === planID);
    if (!plan) {
      return;
    }
    this.setDraft({
      apiKey: "",
      baseUrl: plan.baseUrl ?? "",
      defaultModel: plan.defaultModel ?? "",
      enabled: plan.enabled,
      hasApiKey: plan.hasApiKey,
      models: plan.models.map((model) => ({ ...model })),
      name: plan.name,
      planId: plan.id,
      protocol: plan.protocol,
      templateId: null,
      templateKind: plan.templateKind
    });
  }

  updateDraft(patch: Partial<WorkspaceModelPlanDraft>): void {
    const draft = this.state.draft;
    if (!draft) {
      return;
    }
    const invalidatesDetection =
      (patch.apiKey !== undefined && patch.apiKey !== draft.apiKey) ||
      (patch.baseUrl !== undefined && patch.baseUrl !== draft.baseUrl) ||
      (patch.protocol !== undefined && patch.protocol !== draft.protocol);
    this.state.draft = { ...draft, ...patch };
    this.state.draftFeedback = null;
    if (invalidatesDetection) {
      this.state.draftDetection = null;
    }
  }

  cancelDraft(): void {
    this.state.draft = null;
    this.state.draftDetection = null;
    this.state.draftDiscoveredModels = [];
    this.state.draftFeedback = null;
  }

  async detectDraft(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const draft = this.state.draft;
    if (!workspaceID || !draft || this.state.detecting) {
      return;
    }
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl && !draft.planId) {
      this.setDraftFeedback("requiredFields");
      return;
    }
    this.state.draftFeedback = null;
    this.state.draftDetection = null;
    this.state.detecting = true;
    try {
      const models = normalizeModels(draft.models);
      const request: DetectModelPlanInput = {
        ...(draft.planId ? { planId: draft.planId } : {}),
        protocol: draft.protocol,
        ...(baseUrl ? { baseUrl } : {}),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
        ...(models.length > 0
          ? { models: models.map(({ id, name }) => ({ id, name })) }
          : {}),
        ...(draft.defaultModel.trim()
          ? { model: draft.defaultModel.trim() }
          : {})
      };
      const result = await this.dependencies.client.detectModelPlan(
        workspaceID,
        request
      );
      this.state.draftDetection = result.detection;
      this.state.draftDiscoveredModels = result.discoveredModels;
      const currentDraft = this.state.draft;
      if (
        currentDraft &&
        currentDraft.models.length === 0 &&
        result.discoveredModels.length > 0
      ) {
        this.state.draft = {
          ...currentDraft,
          defaultModel:
            currentDraft.defaultModel || (result.discoveredModels[0]?.id ?? ""),
          models: normalizeModels(result.discoveredModels)
        };
      }
      if (draft.planId) {
        await this.reloadPlan(draft.planId);
      }
    } catch {
      this.setDraftFeedback("detectFailed");
    } finally {
      this.state.detecting = false;
    }
  }

  addDiscoveredModelToDraft(modelID: string): void {
    const draft = this.state.draft;
    if (!draft) {
      return;
    }
    const discovered = this.state.draftDiscoveredModels.find(
      (model) => model.id === modelID
    );
    if (!discovered) {
      return;
    }
    const models = normalizeModels([...draft.models, discovered]);
    this.state.draft = {
      ...draft,
      defaultModel: draft.defaultModel || discovered.id,
      models
    };
  }

  async saveDraft(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const draft = this.state.draft;
    if (!workspaceID || !draft || this.state.saving) {
      return;
    }
    if (!hasRequiredDraftFields(draft)) {
      this.setDraftFeedback("requiredFields");
      return;
    }
    this.state.saving = true;
    try {
      const models = normalizeModels(draft.models);
      const defaultModel = draft.defaultModel.trim();
      const request: PutModelPlanInput = {
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
        baseUrl: draft.baseUrl.trim(),
        ...(defaultModel && models.some((model) => model.id === defaultModel)
          ? { defaultModel }
          : {}),
        enabled: draft.enabled,
        models: models.map(({ id, name }) => ({ id, name })),
        name: draft.name.trim(),
        protocol: draft.protocol,
        templateKind: draft.templateKind
      };
      const saved = draft.planId
        ? await this.dependencies.client.updateModelPlan(
            workspaceID,
            draft.planId,
            request
          )
        : await this.dependencies.client.createModelPlan(workspaceID, request);
      this.upsertPlan(saved);
      this.cancelDraft();
    } catch {
      this.setDraftFeedback("saveFailed");
    } finally {
      this.state.saving = false;
    }
  }

  async setPlanEnabled(planID: string, enabled: boolean): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.state.togglingPlanID) {
      return;
    }
    this.clearPlanFeedback(planID);
    this.state.togglingPlanID = planID;
    try {
      const updated = await this.dependencies.client.setModelPlanEnabled(
        workspaceID,
        planID,
        enabled
      );
      this.upsertPlan(updated);
    } catch {
      this.setPlanFeedback(planID, "toggleFailed");
    } finally {
      this.state.togglingPlanID = null;
    }
  }

  async duplicatePlan(planID: string): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.state.duplicatingPlanID) {
      return;
    }
    this.clearPlanFeedback(planID);
    this.state.duplicatingPlanID = planID;
    try {
      const duplicated = await this.dependencies.client.duplicateModelPlan(
        workspaceID,
        planID
      );
      this.upsertPlan(duplicated);
    } catch {
      this.setPlanFeedback(planID, "duplicateFailed");
    } finally {
      this.state.duplicatingPlanID = null;
    }
  }

  async requestDeletePlan(planID: string): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.state.deletingPlanID) {
      return;
    }
    this.clearPlanFeedback(planID);
    this.state.deleteBlock = null;
    this.state.deletingPlanID = planID;
    try {
      const references = await this.dependencies.client.listModelPlanReferences(
        workspaceID,
        planID
      );
      if (references.length > 0) {
        this.state.deleteBlock = { planID, references };
        this.state.confirmingDeletePlanID = null;
      } else {
        this.state.confirmingDeletePlanID = planID;
      }
    } catch {
      this.setPlanFeedback(planID, "deleteFailed");
    } finally {
      this.state.deletingPlanID = null;
    }
  }

  cancelDeletePlan(): void {
    this.state.confirmingDeletePlanID = null;
    this.state.deleteBlock = null;
  }

  async confirmDeletePlan(planID: string): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.state.deletingPlanID) {
      return;
    }
    this.state.deletingPlanID = planID;
    try {
      await this.dependencies.client.deleteModelPlan(workspaceID, planID);
      this.state.plans = this.state.plans.filter((plan) => plan.id !== planID);
      this.state.confirmingDeletePlanID = null;
      if (this.state.draft?.planId === planID) {
        this.cancelDraft();
      }
    } catch (error) {
      this.state.confirmingDeletePlanID = null;
      if (isModelPlanReferencedError(error)) {
        await this.showDeleteBlock(workspaceID, planID);
      } else {
        this.setPlanFeedback(planID, "deleteFailed");
      }
    } finally {
      this.state.deletingPlanID = null;
    }
  }

  async setAgentBinding(
    agentTargetID: string,
    change: WorkspaceAgentModelBindingChange
  ): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const bindings = this.state.bindings;
    if (!workspaceID || bindings.savingTargetID) {
      return;
    }
    const existing = bindings.bindings.find(
      (binding) => binding.agentTargetId === agentTargetID
    );
    bindings.saveFailedTargetID = null;
    bindings.savingTargetID = agentTargetID;
    try {
      const saved = await this.dependencies.client.setAgentModelBinding(
        workspaceID,
        agentTargetID,
        {
          defaultModel: change.defaultModel ?? null,
          modelPlanId: change.modelPlanID ?? null,
          modelPolicyId: existing?.modelPolicyId ?? null
        }
      );
      const rest = bindings.bindings.filter(
        (binding) => binding.agentTargetId !== agentTargetID
      );
      bindings.bindings = [...rest, saved];
    } catch {
      bindings.saveFailedTargetID = agentTargetID;
    } finally {
      bindings.savingTargetID = null;
    }
  }

  private async showDeleteBlock(
    workspaceID: string,
    planID: string
  ): Promise<void> {
    try {
      const references = await this.dependencies.client.listModelPlanReferences(
        workspaceID,
        planID
      );
      this.state.deleteBlock = { planID, references };
    } catch {
      this.state.deleteBlock = { planID, references: [] };
    }
  }

  private async reloadPlan(planID: string): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID) {
      return;
    }
    try {
      const plans = await this.dependencies.client.listModelPlans(workspaceID);
      const refreshed = plans.find((plan) => plan.id === planID);
      this.state.plans = plans;
      if (!refreshed) {
        return;
      }
    } catch {
      // Detection already surfaced its own result; a stale list row is
      // recoverable on the next refresh.
    }
  }

  private setDraft(draft: WorkspaceModelPlanDraft): void {
    this.state.draft = draft;
    this.state.draftDetection = null;
    this.state.draftDiscoveredModels = [];
    this.state.draftFeedback = null;
    this.state.confirmingDeletePlanID = null;
    this.state.deleteBlock = null;
  }

  private upsertPlan(plan: WorkspaceModelPlan): void {
    const exists = this.state.plans.some(
      (candidate) => candidate.id === plan.id
    );
    this.state.plans = exists
      ? this.state.plans.map((candidate) =>
          candidate.id === plan.id ? plan : candidate
        )
      : [...this.state.plans, plan];
  }

  private setDraftFeedback(kind: WorkspaceModelPlanFeedbackKind): void {
    this.state.draftFeedback = { kind };
  }

  private setPlanFeedback(
    planID: string,
    kind: WorkspaceModelPlanFeedbackKind
  ): void {
    this.state.planFeedback = {
      ...this.state.planFeedback,
      [planID]: { kind }
    };
  }

  private clearPlanFeedback(planID: string): void {
    if (!this.state.planFeedback[planID]) {
      return;
    }
    const next = { ...this.state.planFeedback };
    delete next[planID];
    this.state.planFeedback = next;
  }
}

function hasRequiredDraftFields(draft: WorkspaceModelPlanDraft): boolean {
  return (
    draft.name.trim().length > 0 &&
    draft.baseUrl.trim().length > 0 &&
    (draft.hasApiKey || draft.apiKey.trim().length > 0)
  );
}

function normalizeModels(
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
      id,
      name: model.name.trim() || id
    });
  }
  return normalized;
}

function createActiveTranslator() {
  return createTranslator(getActiveLocale());
}
