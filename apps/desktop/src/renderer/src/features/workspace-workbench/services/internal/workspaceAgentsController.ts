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
    | "deleteWorkspaceAgent"
    | "listAgentTargets"
    | "listWorkspaceAgents"
    | "updateWorkspaceAgent"
  >;
  onWorkspaceAgentsChanged?: () => void | Promise<void>;
  store: WorkspaceSettingsStoreState;
}

/**
 * Owns settings interaction state for explicit workspace Agent definitions.
 * The daemon remains authoritative for validation, migration, revisions, and
 * the Agent Runtime + ModelPlan runtime mapping.
 */
export class WorkspaceAgentsController implements IWorkspaceAgentsController {
  private readonly dependencies: WorkspaceAgentsControllerDependencies;
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
      description: "",
      harnessAgentTargetId: harness?.id ?? "",
      modelPlanId: "",
      defaultModel: "",
      instructions: "",
      callConditions: "",
      dormant: neutralWorkspaceAgentDormantFields()
    };
    this.state.feedback = null;
    this.state.confirmingDeleteAgentID = null;
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
  }

  updateDraft(patch: Partial<WorkspaceAgentDraft>): void {
    if (!this.state.draft) {
      return;
    }
    this.state.draft = { ...this.state.draft, ...patch };
    this.state.feedback = null;
  }

  cancelDraft(): void {
    this.state.draft = null;
    this.state.feedback = null;
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
      if (state.draft === draft) {
        state.draft = null;
        state.feedback = null;
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

  private async refreshAgentDirectory(): Promise<void> {
    try {
      await this.dependencies.onWorkspaceAgentsChanged?.();
    } catch {
      // The persisted daemon write is authoritative. Directory consumers retry
      // on focus and on their next ordinary refresh.
    }
  }
}

/**
 * The editor does not expose failover chains or capability allowlists. The
 * draft passes the stored dormant values through verbatim, so saving an
 * Agent never clears configuration the editor cannot show (W3(2)-2).
 */
export function workspaceAgentDraftToPutInput(
  draft: Readonly<WorkspaceAgentDraft>
): PutWorkspaceAgentInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    harnessAgentTargetId: draft.harnessAgentTargetId.trim(),
    modelPlanId: draft.modelPlanId.trim() || null,
    defaultModel: draft.defaultModel.trim() || null,
    modelFallbacks: [...draft.dormant.modelFallbacks],
    instructions: draft.instructions.trim(),
    callConditions: parseWorkspaceAgentList(draft.callConditions),
    capabilitiesExplicit: draft.dormant.capabilitiesExplicit,
    skills: [...draft.dormant.skills],
    tools: [...draft.dormant.tools]
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
    description: agent.description ?? "",
    harnessAgentTargetId: agent.harness.agentTargetId,
    modelPlanId: agent.modelPlanId ?? "",
    defaultModel: agent.defaultModel ?? "",
    instructions: agent.instructions ?? "",
    callConditions: agent.callConditions.join("\n"),
    dormant: {
      capabilitiesExplicit: agent.capabilitiesExplicit,
      modelFallbacks: agent.modelFallbacks,
      skills: agent.skills,
      tools: agent.tools
    }
  };
}

function neutralWorkspaceAgentDormantFields(): WorkspaceAgentDraft["dormant"] {
  return {
    capabilitiesExplicit: false,
    modelFallbacks: [],
    skills: [],
    tools: []
  };
}
