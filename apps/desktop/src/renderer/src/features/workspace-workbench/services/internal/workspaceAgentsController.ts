import type { IWorkspaceAgentsController } from "../workspaceSettingsService.interface";
import type {
  WorkspaceAgentDefinition,
  WorkspaceAgentDraft,
  WorkspaceSettingsStoreState
} from "../workspaceSettingsTypes.ts";
import type {
  DesktopWorkspaceSettingsClient,
  PutWorkspaceAgentInput
} from "./adapters/desktopWorkspaceSettingsClient.ts";
import { createWorkspaceSettingsAgentsState } from "./workspaceSettingsStore.ts";

export interface WorkspaceAgentsControllerDependencies {
  client: Pick<
    DesktopWorkspaceSettingsClient,
    | "createWorkspaceAgent"
    | "createAutomationRule"
    | "deleteWorkspaceAgent"
    | "generateWorkspaceAgentDraft"
    | "getAgentProviderComposerOptions"
    | "listAgentTargets"
    | "listWorkspaceAgents"
    | "recommendWorkspaceModels"
    | "updateWorkspaceAgent"
  >;
  onWorkspaceAgentsChanged?: () => void | Promise<void>;
  store: WorkspaceSettingsStoreState;
}

/**
 * Owns settings interaction state for explicit workspace Agent definitions.
 * The daemon remains authoritative for validation, migration, revisions, and
 * the Harness + ModelPlan runtime mapping.
 */
export class WorkspaceAgentsController implements IWorkspaceAgentsController {
  private readonly dependencies: WorkspaceAgentsControllerDependencies;
  private capabilityRefreshSequence = 0;
  private refreshSequence = 0;

  constructor(dependencies: WorkspaceAgentsControllerDependencies) {
    this.dependencies = dependencies;
  }

  private get store() {
    return this.dependencies.store;
  }

  private get state() {
    return this.store.agents;
  }

  reset(): void {
    this.capabilityRefreshSequence += 1;
    this.refreshSequence += 1;
    this.store.agents = createWorkspaceSettingsAgentsState();
  }

  async refresh(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.state.loading) {
      return;
    }
    const state = this.state;
    const refreshSequence = ++this.refreshSequence;
    state.loading = true;
    state.loadFailed = false;
    try {
      const [agents, targets] = await Promise.all([
        this.dependencies.client.listWorkspaceAgents(workspaceID),
        this.dependencies.client.listAgentTargets()
      ]);
      if (
        refreshSequence !== this.refreshSequence ||
        workspaceID !== this.store.workspaceID
      ) {
        return;
      }
      state.agents = agents;
      state.harnessTargets = targets
        .filter((target) => target.source === "system")
        .sort(
          (left, right) =>
            left.sortOrder - right.sortOrder ||
            left.name.localeCompare(right.name)
        )
        .map((target) => ({
          enabled: target.enabled,
          id: target.id,
          name: target.name,
          provider: target.provider
        }));
    } catch {
      if (
        refreshSequence === this.refreshSequence &&
        workspaceID === this.store.workspaceID
      ) {
        state.loadFailed = true;
      }
    } finally {
      if (
        refreshSequence === this.refreshSequence &&
        workspaceID === this.store.workspaceID
      ) {
        state.loading = false;
      }
    }
  }

  beginDraft(): void {
    const harness = this.state.harnessTargets.find((target) => target.enabled);
    this.state.draft = {
      agentId: null,
      name: "",
      purpose: "",
      harnessAgentTargetId: harness?.id ?? "",
      modelPlanId: "",
      defaultModel: "",
      modelFallbacks: [],
      instructions: "",
      callConditions: "",
      capabilitiesExplicit: false,
      skills: "",
      tools: "",
      permissions: "",
      enabled: true,
      generationRequirements: "",
      generatedAutomationRules: []
    };
    this.state.feedback = null;
    this.state.confirmingDeleteAgentID = null;
    void this.refreshCapabilityCatalog();
  }

  beginEditAgent(agentID: string): void {
    const agent = this.state.agents.find(
      (candidate) => candidate.id === agentID
    );
    if (!agent) {
      return;
    }
    this.state.draft = workspaceAgentToDraft(agent);
    this.state.feedback = null;
    this.state.confirmingDeleteAgentID = null;
    void this.refreshCapabilityCatalog();
  }

  updateDraft(patch: Partial<WorkspaceAgentDraft>): void {
    if (!this.state.draft) {
      return;
    }
    const invalidatesGeneratedRules =
      (patch.harnessAgentTargetId !== undefined &&
        patch.harnessAgentTargetId !== this.state.draft.harnessAgentTargetId) ||
      (patch.modelPlanId !== undefined &&
        patch.modelPlanId !== this.state.draft.modelPlanId) ||
      (patch.defaultModel !== undefined &&
        patch.defaultModel !== this.state.draft.defaultModel);
    const changesHarness =
      patch.harnessAgentTargetId !== undefined &&
      patch.harnessAgentTargetId !== this.state.draft.harnessAgentTargetId;
    this.state.draft = {
      ...this.state.draft,
      ...patch,
      ...(changesHarness
        ? {
            capabilitiesExplicit: false,
            skills: "",
            tools: ""
          }
        : {}),
      ...(invalidatesGeneratedRules ? { generatedAutomationRules: [] } : {})
    };
    this.state.feedback = null;
    if (changesHarness) {
      this.state.capabilityCatalog = [];
      this.state.capabilityCatalogHarnessTargetID = null;
      void this.refreshCapabilityCatalog();
    }
  }

  cancelDraft(): void {
    this.capabilityRefreshSequence += 1;
    this.state.draft = null;
    this.state.feedback = null;
    this.state.capabilityCatalog = [];
    this.state.capabilityCatalogHarnessTargetID = null;
    this.state.capabilityCatalogLoadFailed = false;
    this.state.capabilityCatalogLoading = false;
  }

  async refreshCapabilityCatalog(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const state = this.state;
    const harnessTargetID = state.draft?.harnessAgentTargetId.trim() ?? "";
    const harness = state.harnessTargets.find(
      (target) => target.id === harnessTargetID
    );
    if (!workspaceID || !state.draft || !harnessTargetID || !harness) {
      state.capabilityCatalog = [];
      state.capabilityCatalogHarnessTargetID = null;
      state.capabilityCatalogLoadFailed = false;
      state.capabilityCatalogLoading = false;
      return;
    }
    const refreshSequence = ++this.capabilityRefreshSequence;
    state.capabilityCatalogLoading = true;
    state.capabilityCatalogLoadFailed = false;
    try {
      const options =
        await this.dependencies.client.getAgentProviderComposerOptions(
          workspaceID,
          harness.provider,
          harnessTargetID
        );
      if (
        refreshSequence !== this.capabilityRefreshSequence ||
        workspaceID !== this.store.workspaceID ||
        state !== this.state ||
        state.draft?.harnessAgentTargetId.trim() !== harnessTargetID
      ) {
        return;
      }
      state.capabilityCatalog = [...options.capabilityCatalog].sort(
        (left, right) =>
          workspaceAgentCapabilityKindRank(left.kind) -
            workspaceAgentCapabilityKindRank(right.kind) ||
          left.label.localeCompare(right.label)
      );
      state.capabilityCatalogHarnessTargetID = harnessTargetID;
    } catch {
      if (
        refreshSequence === this.capabilityRefreshSequence &&
        workspaceID === this.store.workspaceID &&
        state === this.state &&
        state.draft?.harnessAgentTargetId.trim() === harnessTargetID
      ) {
        state.capabilityCatalog = [];
        state.capabilityCatalogHarnessTargetID = harnessTargetID;
        state.capabilityCatalogLoadFailed = true;
      }
    } finally {
      if (
        refreshSequence === this.capabilityRefreshSequence &&
        workspaceID === this.store.workspaceID &&
        state === this.state
      ) {
        state.capabilityCatalogLoading = false;
      }
    }
  }

  async addRecommendedFallback(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const state = this.state;
    const draft = state.draft;
    if (!workspaceID || !draft?.modelPlanId || state.recommendingFallback) {
      return;
    }
    const primaryPlan = this.store.modelPlans.plans.find(
      (plan) => plan.id === draft.modelPlanId
    );
    const primaryModelID =
      draft.defaultModel || primaryPlan?.defaultModel || "";
    const requiredCapabilities =
      primaryPlan?.models.find((model) => model.id === primaryModelID)
        ?.capabilities ?? [];

    state.recommendingFallback = true;
    state.feedback = null;
    try {
      const recommendations =
        await this.dependencies.client.recommendWorkspaceModels(workspaceID, {
          limit: 100,
          requiredCapabilities: [...requiredCapabilities]
        });
      const recommendation = recommendations.find(
        (candidate) =>
          candidate.planId !== draft.modelPlanId &&
          !draft.modelFallbacks.some(
            (fallback) =>
              fallback.modelPlanId === candidate.planId &&
              (fallback.model ?? "") === candidate.modelId
          )
      );
      if (
        workspaceID !== this.store.workspaceID ||
        state !== this.state ||
        state.draft !== draft
      ) {
        return;
      }
      if (!recommendation) {
        state.feedback = { kind: "noRecommendation" };
        return;
      }
      state.draft = {
        ...draft,
        modelFallbacks: [
          ...draft.modelFallbacks,
          {
            modelPlanId: recommendation.planId,
            model: recommendation.modelId
          }
        ]
      };
    } catch {
      if (
        workspaceID === this.store.workspaceID &&
        state === this.state &&
        state.draft === draft
      ) {
        state.feedback = { kind: "recommendFailed" };
      }
    } finally {
      state.recommendingFallback = false;
    }
  }

  async generateDraft(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const state = this.state;
    const draft = state.draft;
    if (!workspaceID || !draft || state.generating) {
      return;
    }
    if (!draft.harnessAgentTargetId.trim() || !draft.modelPlanId.trim()) {
      state.feedback = { kind: "generationRequiresPlan" };
      return;
    }
    state.generating = true;
    state.feedback = null;
    try {
      const generated =
        await this.dependencies.client.generateWorkspaceAgentDraft(
          workspaceID,
          {
            harnessAgentTargetId: draft.harnessAgentTargetId.trim(),
            model: draft.defaultModel.trim() || null,
            modelPlanId: draft.modelPlanId.trim(),
            requirements: draft.generationRequirements.trim()
          }
        );
      if (
        workspaceID !== this.store.workspaceID ||
        state !== this.state ||
        state.draft !== draft
      ) {
        return;
      }
      state.draft = {
        ...draft,
        capabilitiesExplicit: true,
        generatedAutomationRules: generated.automationRules,
        instructions: generated.instructions,
        callConditions: generated.callConditions.join("\n"),
        name: generated.name,
        purpose: generated.purpose,
        skills: generated.skills.join("\n")
      };
    } catch {
      if (
        workspaceID === this.store.workspaceID &&
        state === this.state &&
        state.draft === draft
      ) {
        state.feedback = { kind: "generateFailed" };
      }
    } finally {
      state.generating = false;
    }
  }

  async saveDraft(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const state = this.state;
    const draft = state.draft;
    if (!workspaceID || !draft || state.saving) {
      return;
    }
    if (!draft.name.trim() || !draft.harnessAgentTargetId.trim()) {
      state.feedback = { kind: "requiredFields" };
      return;
    }
    state.saving = true;
    state.feedback = null;
    try {
      const input = workspaceAgentDraftToPutInput(draft);
      const saved = draft.agentId
        ? await this.dependencies.client.updateWorkspaceAgent(
            workspaceID,
            draft.agentId,
            input
          )
        : await this.dependencies.client.createWorkspaceAgent(
            workspaceID,
            input
          );
      if (workspaceID !== this.store.workspaceID || state !== this.state) {
        return;
      }
      this.upsertAgent(state, saved);
      await this.refreshAgentDirectory();
      let pendingRules = [...draft.generatedAutomationRules];
      let persistedDraft: WorkspaceAgentDraft = {
        ...draft,
        agentId: saved.id,
        generatedAutomationRules: pendingRules
      };
      while (pendingRules.length > 0) {
        const suggestion = pendingRules[0];
        if (!suggestion) break;
        try {
          const createdRule =
            await this.dependencies.client.createAutomationRule(workspaceID, {
              action: "consult",
              budget: {
                maxRunsPerSession: suggestion.maxRunsPerSession,
                maxTotalTokensPerSession: suggestion.maxTotalTokensPerSession
              },
              enabled: false,
              name: suggestion.name,
              permissions: { allowedTools: [], permissionModeId: null },
              prompt: suggestion.prompt,
              sourceWorkspaceAgentId: saved.id,
              target: {
                kind: "model",
                model: suggestion.model ?? null,
                modelPlanId: suggestion.modelPlanId,
                requiredCapabilities: []
              },
              trigger: suggestion.trigger
            });
          this.upsertAutomationRule(createdRule);
          pendingRules = pendingRules.slice(1);
          persistedDraft = {
            ...persistedDraft,
            generatedAutomationRules: pendingRules
          };
        } catch {
          if (workspaceID === this.store.workspaceID && state === this.state) {
            state.draft = persistedDraft;
            state.feedback = { kind: "generatedRulesSaveFailed" };
          }
          return;
        }
      }
      if (state.draft === draft) {
        state.draft = null;
        state.feedback = null;
        state.capabilityCatalog = [];
        state.capabilityCatalogHarnessTargetID = null;
      }
    } catch {
      if (
        workspaceID === this.store.workspaceID &&
        state === this.state &&
        state.draft === draft
      ) {
        state.feedback = { kind: "saveFailed" };
      }
    } finally {
      state.saving = false;
    }
  }

  requestDeleteAgent(agentID: string): void {
    if (this.state.deletingAgentID) {
      return;
    }
    this.state.confirmingDeleteAgentID = agentID;
    this.state.feedback = null;
  }

  cancelDeleteAgent(): void {
    this.state.confirmingDeleteAgentID = null;
  }

  async confirmDeleteAgent(agentID: string): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const state = this.state;
    if (!workspaceID || state.deletingAgentID) {
      return;
    }
    state.deletingAgentID = agentID;
    state.feedback = null;
    try {
      await this.dependencies.client.deleteWorkspaceAgent(workspaceID, agentID);
      if (workspaceID !== this.store.workspaceID || state !== this.state) {
        return;
      }
      state.agents = state.agents.filter((agent) => agent.id !== agentID);
      state.confirmingDeleteAgentID = null;
      if (state.draft?.agentId === agentID) {
        state.draft = null;
        state.feedback = null;
      }
      await this.refreshAgentDirectory();
    } catch {
      if (workspaceID === this.store.workspaceID && state === this.state) {
        state.feedback = { kind: "deleteFailed" };
      }
    } finally {
      state.deletingAgentID = null;
    }
  }

  private upsertAgent(
    state: WorkspaceSettingsStoreState["agents"],
    agent: WorkspaceAgentDefinition
  ): void {
    const index = state.agents.findIndex(
      (candidate) => candidate.id === agent.id
    );
    if (index < 0) {
      state.agents = [...state.agents, agent];
      return;
    }
    state.agents = state.agents.map((candidate) =>
      candidate.id === agent.id ? agent : candidate
    );
  }

  private upsertAutomationRule(
    rule: WorkspaceSettingsStoreState["automationRules"]["rules"][number]
  ): void {
    const rules = this.store.automationRules.rules;
    const exists = rules.some((candidate) => candidate.id === rule.id);
    this.store.automationRules.rules = exists
      ? rules.map((candidate) => (candidate.id === rule.id ? rule : candidate))
      : [...rules, rule];
  }

  private async refreshAgentDirectory(): Promise<void> {
    try {
      await this.dependencies.onWorkspaceAgentsChanged?.();
    } catch {
      // The persisted daemon write is authoritative. Directory consumers retry
      // on focus and on their next ordinary refresh.
    }
  }
}

export function workspaceAgentDraftToPutInput(
  draft: Readonly<WorkspaceAgentDraft>
): PutWorkspaceAgentInput {
  return {
    name: draft.name.trim(),
    purpose: draft.purpose.trim(),
    harnessAgentTargetId: draft.harnessAgentTargetId.trim(),
    modelPlanId: draft.modelPlanId.trim() || null,
    defaultModel: draft.defaultModel.trim() || null,
    modelFallbacks: draft.modelFallbacks.map((fallback) => ({
      modelPlanId: fallback.modelPlanId.trim(),
      model: fallback.model?.trim() || null
    })),
    instructions: draft.instructions.trim(),
    callConditions: parseWorkspaceAgentList(draft.callConditions),
    capabilitiesExplicit: draft.capabilitiesExplicit,
    skills: parseWorkspaceAgentList(draft.skills),
    tools: parseWorkspaceAgentList(draft.tools),
    permissions: parseWorkspaceAgentList(draft.permissions),
    enabled: draft.enabled
  };
}

export function parseWorkspaceAgentList(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of value.split(/\r?\n/u)) {
    const item = line.trim();
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function workspaceAgentToDraft(
  agent: WorkspaceAgentDefinition
): WorkspaceAgentDraft {
  return {
    agentId: agent.id,
    name: agent.name,
    purpose: agent.purpose ?? "",
    harnessAgentTargetId: agent.harness.agentTargetId,
    modelPlanId: agent.modelPlanId ?? "",
    defaultModel: agent.defaultModel ?? "",
    modelFallbacks: agent.modelFallbacks.map((fallback) => ({ ...fallback })),
    instructions: agent.instructions ?? "",
    callConditions: agent.callConditions.join("\n"),
    capabilitiesExplicit: agent.capabilitiesExplicit,
    skills: agent.skills.join("\n"),
    tools: agent.tools.join("\n"),
    permissions: agent.permissions.join("\n"),
    enabled: agent.enabled,
    generationRequirements: "",
    generatedAutomationRules: []
  };
}

function workspaceAgentCapabilityKindRank(kind: string): number {
  switch (kind) {
    case "skill":
      return 0;
    case "plugin":
      return 1;
    case "connector":
      return 2;
    case "mcpServer":
      return 3;
    case "mcpTool":
      return 4;
    default:
      return 5;
  }
}
