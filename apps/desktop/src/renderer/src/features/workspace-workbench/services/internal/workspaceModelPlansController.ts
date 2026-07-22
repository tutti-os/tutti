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
  WorkspaceSettingsStoreState
} from "../workspaceSettingsTypes.ts";
import {
  createEmptyWorkspaceModelPlanDraftModel,
  repairWorkspaceModelPlanDraftDefault
} from "../workspaceModelPlanDraftModels.ts";
import type {
  DesktopWorkspaceSettingsClient,
  PutModelPlanInput
} from "./adapters/desktopWorkspaceSettingsClient.ts";
import { isModelPlanReferencedError } from "./adapters/desktopWorkspaceSettingsClient.ts";
import {
  buildWorkspaceModelPlanDetectRequest,
  hasRequiredWorkspaceModelPlanDraftFields,
  normalizeWorkspaceModelPlanDraftModels,
  workspaceModelPlanConnectionChanged,
  workspaceModelPlanDetectionCorePassed,
  workspaceModelPlanModelRangeChanged
} from "./workspaceModelPlanDraftRules.ts";
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
 * Owns the workspace model-plan settings slice. Legacy fixed-target bindings
 * remain available through explicit compatibility methods, but the default
 * settings refresh is Plan-only because WorkspaceAgents own new mappings.
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
    await this.refreshPlans();
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
    this.setDraft({
      apiKey: "",
      baseUrl: seed.baseUrl ?? "",
      defaultModel: "",
      enabled: true,
      hasApiKey: false,
      models: [createEmptyWorkspaceModelPlanDraftModel()],
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
    const selection = repairWorkspaceModelPlanDraftDefault(
      plan.models.map((model) => ({ ...model })),
      plan.defaultModel ?? ""
    );
    this.setDraft({
      apiKey: "",
      baseUrl: plan.baseUrl ?? "",
      enabled: plan.enabled,
      hasApiKey: plan.hasApiKey,
      name: plan.name,
      planId: plan.id,
      protocol: plan.protocol,
      ...selection,
      templateId: null,
      templateKind: plan.templateKind
    });
  }

  updateDraft(patch: Partial<WorkspaceModelPlanDraft>): void {
    const draft = this.state.draft;
    if (!draft) {
      return;
    }
    const invalidatesConnection =
      (patch.apiKey !== undefined && patch.apiKey !== draft.apiKey) ||
      (patch.baseUrl !== undefined && patch.baseUrl !== draft.baseUrl) ||
      (patch.protocol !== undefined && patch.protocol !== draft.protocol);
    let nextDraft = { ...draft, ...patch };
    if (patch.models !== undefined || patch.defaultModel !== undefined) {
      const selection = repairWorkspaceModelPlanDraftDefault(
        nextDraft.models,
        nextDraft.defaultModel
      );
      nextDraft = { ...nextDraft, ...selection };
    }
    this.state.draft = nextDraft;
    this.state.draftFeedback = null;
    this.state.draftSaveImpact = null;
    if (invalidatesConnection) {
      // A new connection identity invalidates both the check result and the
      // model catalog that the previous credentials discovered.
      this.state.draftDetection = null;
      this.state.draftDiscoveredModels = [];
    }
  }

  cancelDraft(): void {
    this.state.draft = null;
    this.state.draftDetection = null;
    this.state.draftDiscoveredModels = [];
    this.state.draftFeedback = null;
    this.state.draftSaveImpact = null;
  }

  async detectDraft(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const draft = this.state.draft;
    if (
      !workspaceID ||
      !draft ||
      this.state.detecting ||
      this.state.fetchingDraftModels
    ) {
      return;
    }
    const request = buildWorkspaceModelPlanDetectRequest(draft);
    if (!request) {
      this.setDraftFeedback("requiredFields");
      return;
    }
    this.state.draftFeedback = null;
    this.state.draftDetection = null;
    this.state.detecting = true;
    try {
      const result = await this.dependencies.client.detectModelPlan(
        workspaceID,
        request
      );
      if (this.state.draft !== draft) {
        // The draft changed while the check was in flight; a stale result
        // must not attach to (or unlock saving for) the newer draft.
        return;
      }
      this.state.draftDetection = result.detection;
      this.state.draftDiscoveredModels = result.discoveredModels;
      if (draft.planId) {
        await this.reloadPlan(draft.planId);
      }
    } catch {
      if (this.state.draft === draft) {
        this.setDraftFeedback("detectFailed");
      }
    } finally {
      this.state.detecting = false;
    }
  }

  /**
   * Explicit "fetch models" step: runs the daemon detection chain for its
   * discovery output only. The result feeds the picker catalog; it never
   * stands in for the final connection check that gates saving.
   */
  async fetchDraftModels(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const draft = this.state.draft;
    if (
      !workspaceID ||
      !draft ||
      this.state.detecting ||
      this.state.fetchingDraftModels
    ) {
      return;
    }
    const request = buildWorkspaceModelPlanDetectRequest(draft);
    if (!request) {
      this.setDraftFeedback("requiredFields");
      return;
    }
    this.state.draftFeedback = null;
    this.state.fetchingDraftModels = true;
    try {
      const result = await this.dependencies.client.detectModelPlan(
        workspaceID,
        request
      );
      if (this.state.draft !== draft) {
        // The draft changed while the fetch was in flight; stale candidates
        // must not leak into the newer draft's catalog.
        return;
      }
      this.state.draftDiscoveredModels = result.discoveredModels;
      if (result.discoveredModels.length === 0) {
        const discovery = result.detection.stages.find(
          (stage) => stage.stage === "model_discovery"
        );
        if (discovery?.status === "passed") {
          // Only an explicitly passed discovery is an empty catalog. The
          // neutral message keeps the button from appearing unresponsive.
          this.setDraftFeedback("fetchModelsEmpty");
        } else {
          // Failed, missing, or skipped discovery (an earlier stage such as
          // network or auth failed, so discovery never ran) means the fetch
          // produced no catalog — surface it as a failure.
          this.setDraftFeedback("fetchModelsFailed");
        }
      }
    } catch {
      if (this.state.draft === draft) {
        this.setDraftFeedback("fetchModelsFailed");
      }
    } finally {
      this.state.fetchingDraftModels = false;
    }
  }

  async saveDraft(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const draft = this.state.draft;
    if (!workspaceID || !draft || this.state.saving) {
      return;
    }
    if (!hasRequiredWorkspaceModelPlanDraftFields(draft)) {
      this.setDraftFeedback("requiredFields");
      return;
    }
    const storedPlan = draft.planId
      ? this.state.plans.find((plan) => plan.id === draft.planId)
      : undefined;
    const requiresPersistedDetection =
      !draft.planId || workspaceModelPlanConnectionChanged(draft, storedPlan);
    if (
      requiresPersistedDetection &&
      !workspaceModelPlanDetectionCorePassed(this.state.draftDetection)
    ) {
      this.setDraftFeedback("detectionRequired");
      return;
    }
    if (
      draft.planId &&
      workspaceModelPlanModelRangeChanged(draft, storedPlan) &&
      this.state.draftSaveImpact?.planID !== draft.planId
    ) {
      this.state.saving = true;
      try {
        const references =
          await this.dependencies.client.listModelPlanReferences(
            workspaceID,
            draft.planId
          );
        if (
          workspaceID !== this.store.workspaceID ||
          this.state.draft !== draft
        ) {
          return;
        }
        if (references.length > 0) {
          this.state.draftSaveImpact = {
            planID: draft.planId,
            references
          };
          return;
        }
      } catch {
        if (
          workspaceID === this.store.workspaceID &&
          this.state.draft === draft
        ) {
          this.setDraftFeedback("saveFailed");
        }
        return;
      } finally {
        this.state.saving = false;
      }
    }
    this.state.saving = true;
    try {
      const models = normalizeWorkspaceModelPlanDraftModels(draft.models);
      const defaultModel = draft.defaultModel.trim();
      const request: PutModelPlanInput = {
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
        baseUrl: draft.baseUrl.trim(),
        ...(defaultModel && models.some((model) => model.id === defaultModel)
          ? { defaultModel }
          : {}),
        enabled: draft.enabled,
        models: models.map(({ capabilities, id, name }) => ({
          ...(capabilities !== undefined
            ? {
                capabilities: capabilities === null ? null : [...capabilities]
              }
            : {}),
          id,
          name
        })),
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
      if (requiresPersistedDetection) {
        // Draft detection proves the proposed endpoint before commit. Repeat
        // the check against the saved Plan identity so the durable list row
        // enters pending_first_use instead of falling back to undetected.
        this.state.draft = {
          ...draft,
          apiKey: "",
          hasApiKey: saved.hasApiKey,
          planId: saved.id
        };
        try {
          const result = await this.dependencies.client.detectModelPlan(
            workspaceID,
            { planId: saved.id }
          );
          this.state.draftDetection = result.detection;
          this.state.draftDiscoveredModels = result.discoveredModels;
          await this.reloadPlan(saved.id);
          if (!workspaceModelPlanDetectionCorePassed(result.detection)) {
            this.setDraftFeedback("detectFailed");
            return;
          }
        } catch {
          this.setDraftFeedback("detectFailed");
          return;
        }
      }
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
      if (!refreshed) {
        return;
      }
      this.state.plans = plans;
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
    this.state.draftSaveImpact = null;
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

function createActiveTranslator() {
  return createTranslator(getActiveLocale());
}
