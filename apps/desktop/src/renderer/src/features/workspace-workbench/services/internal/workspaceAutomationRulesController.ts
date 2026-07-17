import type { IWorkspaceAutomationRulesController } from "../workspaceSettingsService.interface";
import type {
  WorkspaceAutomationRule,
  WorkspaceAutomationRuleDraft,
  WorkspaceAutomationTargetOption,
  WorkspaceSettingsStoreState
} from "../workspaceSettingsTypes.ts";
import type {
  DesktopWorkspaceSettingsClient,
  PutAutomationRuleInput
} from "./adapters/desktopWorkspaceSettingsClient.ts";
import { createWorkspaceSettingsAutomationRulesState } from "./workspaceSettingsStore.ts";

const defaultMaxRunsPerSession = 3;
const defaultMaxTotalTokensPerSession = 200_000;

export interface WorkspaceAutomationRulesControllerDependencies {
  client: Pick<
    DesktopWorkspaceSettingsClient,
    | "createAutomationRule"
    | "deleteAutomationRule"
    | "getAutomationTargetCatalog"
    | "listAgentTargets"
    | "listAutomationRules"
    | "listWorkspaceAgents"
    | "updateAutomationRule"
  >;
  store: WorkspaceSettingsStoreState;
}

/**
 * Owns presentation interaction state for daemon-owned AutomationRules. Rule
 * validation and execution remain authoritative in tuttid. The target
 * directory always merges built-in Harness targets with enabled
 * WorkspaceAgents, and the permission/tool option catalogs follow the
 * selected target's composer capability directory.
 */
export class WorkspaceAutomationRulesController implements IWorkspaceAutomationRulesController {
  private readonly dependencies: WorkspaceAutomationRulesControllerDependencies;
  private refreshSequence = 0;
  private catalogSequence = 0;

  constructor(dependencies: WorkspaceAutomationRulesControllerDependencies) {
    this.dependencies = dependencies;
  }

  private get store() {
    return this.dependencies.store;
  }

  private get state() {
    return this.store.automationRules;
  }

  reset(): void {
    this.refreshSequence += 1;
    this.catalogSequence += 1;
    this.store.automationRules = createWorkspaceSettingsAutomationRulesState();
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
      const [rules, targets, agents] = await Promise.all([
        this.dependencies.client.listAutomationRules(workspaceID),
        this.dependencies.client.listAgentTargets(),
        this.dependencies.client.listWorkspaceAgents(workspaceID)
      ]);
      if (
        refreshSequence !== this.refreshSequence ||
        workspaceID !== this.store.workspaceID
      ) {
        return;
      }
      state.rules = rules;
      state.targetOptions = buildWorkspaceAutomationTargetDirectory(
        targets,
        agents
      );
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
    const defaultTarget = this.state.targetOptions[0]?.id ?? "";
    this.state.draft = {
      allowedTools: [],
      automationRuleId: null,
      enabled: false,
      maxRunsPerSession: String(defaultMaxRunsPerSession),
      maxTotalTokensPerSession: String(defaultMaxTotalTokensPerSession),
      name: "",
      permissionModeId: "",
      prompt: "",
      sourceWorkspaceAgentId: "",
      targetAgentId: defaultTarget,
      trigger: "on_task_complete"
    };
    this.state.feedback = null;
    this.state.confirmingDeleteRuleID = null;
    void this.loadTargetCatalog(defaultTarget);
  }

  beginEditRule(automationRuleID: string): void {
    const rule = this.state.rules.find(
      (candidate) => candidate.id === automationRuleID
    );
    if (!rule) {
      return;
    }
    this.state.draft = workspaceAutomationRuleToDraft(rule);
    this.state.feedback = null;
    this.state.confirmingDeleteRuleID = null;
    void this.loadTargetCatalog(this.state.draft.targetAgentId);
  }

  updateDraft(patch: Partial<WorkspaceAutomationRuleDraft>): void {
    if (!this.state.draft) {
      return;
    }
    this.state.draft = { ...this.state.draft, ...patch };
    this.state.feedback = null;
  }

  async selectDraftTarget(targetAgentID: string): Promise<void> {
    const draft = this.state.draft;
    if (!draft || draft.targetAgentId === targetAgentID) {
      return;
    }
    // Keep current selections until the new catalog answers, then drop the
    // values the new target does not offer.
    this.state.draft = { ...draft, targetAgentId: targetAgentID };
    this.state.feedback = null;
    await this.loadTargetCatalog(targetAgentID);
  }

  async retryTargetCatalog(): Promise<void> {
    const targetAgentID = this.state.draft?.targetAgentId ?? "";
    await this.loadTargetCatalog(targetAgentID);
  }

  private async loadTargetCatalog(targetAgentID: string): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const state = this.state;
    const catalogSequence = ++this.catalogSequence;
    if (!workspaceID || !targetAgentID) {
      state.targetCatalog = null;
      return;
    }
    const provider =
      state.targetOptions.find((option) => option.id === targetAgentID)
        ?.provider ?? "";
    if (!provider) {
      state.targetCatalog = {
        agentTargetId: targetAgentID,
        loadFailed: true,
        loading: false,
        permissionModes: [],
        tools: []
      };
      return;
    }
    state.targetCatalog = {
      agentTargetId: targetAgentID,
      loadFailed: false,
      loading: true,
      permissionModes: [],
      tools: []
    };
    try {
      const catalog = await this.dependencies.client.getAutomationTargetCatalog(
        workspaceID,
        provider,
        targetAgentID
      );
      if (
        catalogSequence !== this.catalogSequence ||
        workspaceID !== this.store.workspaceID
      ) {
        return;
      }
      state.targetCatalog = {
        agentTargetId: targetAgentID,
        loadFailed: false,
        loading: false,
        permissionModes: catalog.permissionModes,
        tools: catalog.tools
      };
      this.pruneDraftForCatalog(targetAgentID);
    } catch {
      if (
        catalogSequence === this.catalogSequence &&
        workspaceID === this.store.workspaceID
      ) {
        state.targetCatalog = {
          agentTargetId: targetAgentID,
          loadFailed: true,
          loading: false,
          permissionModes: [],
          tools: []
        };
      }
    }
  }

  /** Drops selected values the freshly loaded target catalog does not offer. */
  private pruneDraftForCatalog(targetAgentID: string): void {
    const draft = this.state.draft;
    const catalog = this.state.targetCatalog;
    if (!draft || !catalog || draft.targetAgentId !== targetAgentID) {
      return;
    }
    const permissionModeIds = new Set(
      catalog.permissionModes.map((mode) => mode.id)
    );
    const toolIds = new Set(catalog.tools.map((tool) => tool.id));
    const permissionModeId = permissionModeIds.has(draft.permissionModeId)
      ? draft.permissionModeId
      : "";
    const allowedTools = draft.allowedTools.filter((tool) => toolIds.has(tool));
    if (
      permissionModeId === draft.permissionModeId &&
      allowedTools.length === draft.allowedTools.length
    ) {
      return;
    }
    this.state.draft = { ...draft, allowedTools, permissionModeId };
  }

  cancelDraft(): void {
    this.state.draft = null;
    this.state.feedback = null;
    this.state.targetCatalog = null;
  }

  async saveDraft(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const draft = this.state.draft;
    if (!workspaceID || !draft || this.state.saving) {
      return;
    }
    if (!draft.name.trim() || !draft.targetAgentId.trim()) {
      this.state.feedback = { kind: "requiredFields" };
      return;
    }
    const input = workspaceAutomationRuleDraftToPutInput(draft);
    if (!input) {
      this.state.feedback = { kind: "invalidBudget" };
      return;
    }

    const state = this.state;
    state.saving = true;
    state.feedback = null;
    try {
      const saved = draft.automationRuleId
        ? await this.dependencies.client.updateAutomationRule(
            workspaceID,
            draft.automationRuleId,
            input
          )
        : await this.dependencies.client.createAutomationRule(
            workspaceID,
            input
          );
      if (workspaceID !== this.store.workspaceID) {
        return;
      }
      this.upsertRule(state, saved);
      this.cancelDraft();
    } catch {
      if (workspaceID === this.store.workspaceID) {
        state.feedback = { kind: "saveFailed" };
      }
    } finally {
      state.saving = false;
    }
  }

  requestDeleteRule(automationRuleID: string): void {
    if (this.state.deletingRuleID) {
      return;
    }
    this.state.confirmingDeleteRuleID = automationRuleID;
    this.state.feedback = null;
  }

  cancelDeleteRule(): void {
    this.state.confirmingDeleteRuleID = null;
  }

  async confirmDeleteRule(automationRuleID: string): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.state.deletingRuleID) {
      return;
    }
    const state = this.state;
    state.deletingRuleID = automationRuleID;
    state.feedback = null;
    try {
      await this.dependencies.client.deleteAutomationRule(
        workspaceID,
        automationRuleID
      );
      if (workspaceID !== this.store.workspaceID) {
        return;
      }
      state.rules = state.rules.filter((rule) => rule.id !== automationRuleID);
      state.confirmingDeleteRuleID = null;
      if (state.draft?.automationRuleId === automationRuleID) {
        this.cancelDraft();
      }
    } catch {
      if (workspaceID === this.store.workspaceID) {
        state.feedback = { kind: "deleteFailed" };
      }
    } finally {
      state.deletingRuleID = null;
    }
  }

  private upsertRule(
    state: WorkspaceSettingsStoreState["automationRules"],
    rule: WorkspaceAutomationRule
  ): void {
    const exists = state.rules.some((candidate) => candidate.id === rule.id);
    state.rules = exists
      ? state.rules.map((candidate) =>
          candidate.id === rule.id ? rule : candidate
        )
      : [...state.rules, rule];
  }
}

interface AutomationDirectoryTarget {
  readonly enabled: boolean;
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

interface AutomationDirectoryAgent {
  readonly harness: {
    readonly available: boolean;
    readonly enabled?: boolean | null;
    readonly provider?: string | null;
  };
  readonly id: string;
  readonly name: string;
}

function workspaceAgentIsSelectable(agent: AutomationDirectoryAgent): boolean {
  return (
    agent.harness.available &&
    agent.harness.enabled !== false &&
    Boolean(agent.harness.provider)
  );
}

/**
 * Built-in Harness targets and enabled WorkspaceAgents coexist in the
 * automation target directory, mirroring the Tutti Mode assignment
 * directory: built-ins keep their placement so a rule is always
 * configurable, and WorkspaceAgents are appended, deduped by id.
 */
export function buildWorkspaceAutomationTargetDirectory(
  targets: readonly AutomationDirectoryTarget[],
  agents: readonly AutomationDirectoryAgent[]
): WorkspaceAutomationTargetOption[] {
  const options: WorkspaceAutomationTargetOption[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (!target.enabled || seen.has(target.id)) {
      continue;
    }
    seen.add(target.id);
    options.push({
      id: target.id,
      kind: "builtin",
      name: target.name,
      provider: target.provider
    });
  }
  for (const agent of agents) {
    if (!workspaceAgentIsSelectable(agent) || seen.has(agent.id)) {
      continue;
    }
    seen.add(agent.id);
    options.push({
      id: agent.id,
      kind: "workspaceAgent",
      name: agent.name,
      provider: agent.harness.provider ?? ""
    });
  }
  return options;
}

export function workspaceAutomationRuleDraftToPutInput(
  draft: Readonly<WorkspaceAutomationRuleDraft>
): PutAutomationRuleInput | null {
  const maxRunsPerSession = parseNonNegativeInteger(draft.maxRunsPerSession);
  const maxTotalTokensPerSession = parseNonNegativeInteger(
    draft.maxTotalTokensPerSession
  );
  if (maxRunsPerSession === null || maxTotalTokensPerSession === null) {
    return null;
  }

  return {
    budget: { maxRunsPerSession, maxTotalTokensPerSession },
    enabled: draft.enabled,
    name: draft.name.trim(),
    permissions: {
      allowedTools: [...draft.allowedTools],
      permissionModeId: draft.permissionModeId.trim() || null
    },
    prompt: draft.prompt.trim(),
    sourceWorkspaceAgentId: draft.sourceWorkspaceAgentId.trim() || null,
    target: {
      kind: "agent",
      requiredCapabilities: [],
      workspaceAgentId: draft.targetAgentId.trim()
    },
    trigger: draft.trigger
  };
}

function parseNonNegativeInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function workspaceAutomationRuleToDraft(
  rule: WorkspaceAutomationRule
): WorkspaceAutomationRuleDraft {
  return {
    allowedTools: [...rule.permissions.allowedTools],
    automationRuleId: rule.id,
    enabled: rule.enabled,
    maxRunsPerSession: String(rule.budget.maxRunsPerSession),
    maxTotalTokensPerSession: String(rule.budget.maxTotalTokensPerSession),
    name: rule.name,
    permissionModeId: rule.permissions.permissionModeId ?? "",
    prompt: rule.prompt,
    sourceWorkspaceAgentId: rule.sourceWorkspaceAgentId ?? "",
    targetAgentId: rule.target.workspaceAgentId ?? "",
    trigger: rule.trigger
  };
}
