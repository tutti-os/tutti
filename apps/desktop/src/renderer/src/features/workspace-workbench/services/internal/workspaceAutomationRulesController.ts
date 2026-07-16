import type { IWorkspaceAutomationRulesController } from "../workspaceSettingsService.interface";
import type {
  WorkspaceAutomationRule,
  WorkspaceAutomationRuleDraft,
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
    | "listAutomationRules"
    | "updateAutomationRule"
  >;
  store: WorkspaceSettingsStoreState;
}

/**
 * Owns presentation interaction state for daemon-owned AutomationRules. Rule
 * validation and execution remain authoritative in tuttid.
 */
export class WorkspaceAutomationRulesController implements IWorkspaceAutomationRulesController {
  private readonly dependencies: WorkspaceAutomationRulesControllerDependencies;
  private refreshSequence = 0;

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
      const rules =
        await this.dependencies.client.listAutomationRules(workspaceID);
      if (
        refreshSequence !== this.refreshSequence ||
        workspaceID !== this.store.workspaceID
      ) {
        return;
      }
      state.rules = rules;
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
    this.state.draft = {
      action: "consult",
      allowedTools: "",
      automationRuleId: null,
      enabled: false,
      maxRunsPerSession: String(defaultMaxRunsPerSession),
      maxTotalTokensPerSession: String(defaultMaxTotalTokensPerSession),
      model: "",
      modelPlanId: "",
      name: "",
      permissionModeId: "",
      prompt: "",
      requiredCapabilities: "",
      sourceWorkspaceAgentId: "",
      targetWorkspaceAgentId: "",
      trigger: "on_task_complete"
    };
    this.state.feedback = null;
    this.state.confirmingDeleteRuleID = null;
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
  }

  updateDraft(patch: Partial<WorkspaceAutomationRuleDraft>): void {
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
    const draft = this.state.draft;
    if (!workspaceID || !draft || this.state.saving) {
      return;
    }
    if (
      !draft.name.trim() ||
      (draft.action === "consult"
        ? !draft.modelPlanId.trim()
        : !draft.targetWorkspaceAgentId.trim())
    ) {
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

  const consult = draft.action === "consult";
  return {
    action: draft.action,
    budget: { maxRunsPerSession, maxTotalTokensPerSession },
    enabled: draft.enabled,
    name: draft.name.trim(),
    permissions: {
      allowedTools: consult
        ? []
        : parseWorkspaceAutomationRuleList(draft.allowedTools),
      permissionModeId: consult ? null : draft.permissionModeId.trim() || null
    },
    prompt: draft.prompt.trim(),
    sourceWorkspaceAgentId: draft.sourceWorkspaceAgentId.trim() || null,
    target: consult
      ? {
          kind: "model",
          model: draft.model.trim() || null,
          modelPlanId: draft.modelPlanId.trim(),
          requiredCapabilities: parseWorkspaceAutomationRuleList(
            draft.requiredCapabilities
          )
        }
      : {
          kind: "agent",
          requiredCapabilities: [],
          workspaceAgentId: draft.targetWorkspaceAgentId.trim()
        },
    trigger: draft.trigger
  };
}

export function parseWorkspaceAutomationRuleList(value: string): string[] {
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
    action: rule.action,
    allowedTools: rule.permissions.allowedTools.join("\n"),
    automationRuleId: rule.id,
    enabled: rule.enabled,
    maxRunsPerSession: String(rule.budget.maxRunsPerSession),
    maxTotalTokensPerSession: String(rule.budget.maxTotalTokensPerSession),
    model: rule.target.model ?? "",
    modelPlanId: rule.target.modelPlanId ?? "",
    name: rule.name,
    permissionModeId: rule.permissions.permissionModeId ?? "",
    prompt: rule.prompt,
    requiredCapabilities: rule.target.requiredCapabilities.join("\n"),
    sourceWorkspaceAgentId: rule.sourceWorkspaceAgentId ?? "",
    targetWorkspaceAgentId: rule.target.workspaceAgentId ?? "",
    trigger: rule.trigger
  };
}
