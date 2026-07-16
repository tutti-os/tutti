import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationRule } from "@tutti-os/client-tuttid-ts";
import {
  WorkspaceAutomationRulesController,
  type WorkspaceAutomationRulesControllerDependencies
} from "./workspaceAutomationRulesController.ts";
import { createWorkspaceSettingsStore } from "./workspaceSettingsStore.ts";

test("automation rules controller loads workspace rules", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const controller = new WorkspaceAutomationRulesController({
    client: createClient({
      listAutomationRules: async () => [createAutomationRule()]
    }),
    store
  });

  await controller.refresh();

  assert.deepEqual(
    store.automationRules.rules.map((rule) => rule.id),
    ["automation-rule:1"]
  );
  assert.equal(store.automationRules.loadFailed, false);
});

test("automation rules controller starts disabled with PRD review limits", () => {
  const store = createWorkspaceSettingsStore();
  const controller = new WorkspaceAutomationRulesController({
    client: createClient(),
    store
  });

  controller.beginDraft();

  assert.equal(store.automationRules.draft?.enabled, false);
  assert.equal(store.automationRules.draft?.action, "consult");
  assert.equal(store.automationRules.draft?.maxRunsPerSession, "3");
  assert.equal(store.automationRules.draft?.maxTotalTokensPerSession, "200000");
});

test("automation rules controller creates a tool-free model consult", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const requests: unknown[] = [];
  const controller = new WorkspaceAutomationRulesController({
    client: createClient({
      createAutomationRule: async (_workspaceID, input) => {
        requests.push(input);
        return createAutomationRule({
          name: input.name,
          prompt: input.prompt,
          sourceWorkspaceAgentId: input.sourceWorkspaceAgentId,
          target: input.target
        });
      }
    }),
    store
  });
  controller.beginDraft();
  controller.updateDraft({
    allowedTools: "terminal",
    enabled: true,
    model: "gpt-5",
    modelPlanId: "plan-1",
    name: "Completion check",
    permissionModeId: "full-access",
    prompt: "Check the completed task.",
    requiredCapabilities: "reasoning\nreasoning\nvision",
    sourceWorkspaceAgentId: "workspace-agent:source"
  });

  await controller.saveDraft();

  assert.deepEqual(requests, [
    {
      action: "consult",
      budget: {
        maxRunsPerSession: 3,
        maxTotalTokensPerSession: 200000
      },
      enabled: true,
      name: "Completion check",
      permissions: { allowedTools: [], permissionModeId: null },
      prompt: "Check the completed task.",
      sourceWorkspaceAgentId: "workspace-agent:source",
      target: {
        kind: "model",
        model: "gpt-5",
        modelPlanId: "plan-1",
        requiredCapabilities: ["reasoning", "vision"]
      },
      trigger: "on_task_complete"
    }
  ]);
  assert.equal(store.automationRules.draft, null);
});

test("automation rules controller creates a constrained Agent delegation", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const requests: unknown[] = [];
  const controller = new WorkspaceAutomationRulesController({
    client: createClient({
      createAutomationRule: async (_workspaceID, input) => {
        requests.push(input);
        return createAutomationRule({ action: input.action });
      }
    }),
    store
  });
  controller.beginDraft();
  controller.updateDraft({
    action: "delegate",
    allowedTools: "terminal\nbrowser\nterminal",
    maxRunsPerSession: "2",
    maxTotalTokensPerSession: "75000",
    name: "Delegate follow-up",
    permissionModeId: "workspace-write",
    targetWorkspaceAgentId: "workspace-agent:target"
  });

  await controller.saveDraft();

  assert.deepEqual(requests, [
    {
      action: "delegate",
      budget: {
        maxRunsPerSession: 2,
        maxTotalTokensPerSession: 75000
      },
      enabled: false,
      name: "Delegate follow-up",
      permissions: {
        allowedTools: ["terminal", "browser"],
        permissionModeId: "workspace-write"
      },
      prompt: "",
      sourceWorkspaceAgentId: null,
      target: {
        kind: "agent",
        requiredCapabilities: [],
        workspaceAgentId: "workspace-agent:target"
      },
      trigger: "on_task_complete"
    }
  ]);
});

test("automation rules controller rejects invalid budgets before request", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  let createCalls = 0;
  const controller = new WorkspaceAutomationRulesController({
    client: createClient({
      createAutomationRule: async () => {
        createCalls += 1;
        return createAutomationRule();
      }
    }),
    store
  });
  controller.beginDraft();
  controller.updateDraft({
    maxRunsPerSession: "-1",
    modelPlanId: "plan-1",
    name: "Invalid"
  });

  await controller.saveDraft();

  assert.equal(createCalls, 0);
  assert.equal(store.automationRules.feedback?.kind, "invalidBudget");
});

test("automation rules controller does not apply a save after workspace changes", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const request = createDeferred<AutomationRule>();
  const controller = new WorkspaceAutomationRulesController({
    client: createClient({
      createAutomationRule: async () => request.promise
    }),
    store
  });
  controller.beginDraft();
  controller.updateDraft({
    modelPlanId: "plan-1",
    name: "Workspace 1 rule"
  });

  const save = controller.saveDraft();
  store.workspaceID = "workspace-2";
  controller.reset();
  request.resolve(createAutomationRule());
  await save;

  assert.deepEqual(store.automationRules.rules, []);
  assert.equal(store.automationRules.draft, null);
});

test("automation rules controller deletes a selected rule", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.automationRules.rules = [createAutomationRule()];
  const deleted: string[] = [];
  const controller = new WorkspaceAutomationRulesController({
    client: createClient({
      deleteAutomationRule: async (_workspaceID, automationRuleID) => {
        deleted.push(automationRuleID);
      }
    }),
    store
  });

  controller.requestDeleteRule("automation-rule:1");
  await controller.confirmDeleteRule("automation-rule:1");

  assert.deepEqual(deleted, ["automation-rule:1"]);
  assert.deepEqual(store.automationRules.rules, []);
});

function createClient(
  overrides: Partial<
    WorkspaceAutomationRulesControllerDependencies["client"]
  > = {}
): WorkspaceAutomationRulesControllerDependencies["client"] {
  return {
    createAutomationRule: async () => createAutomationRule(),
    deleteAutomationRule: async () => undefined,
    listAutomationRules: async () => [],
    updateAutomationRule: async () => createAutomationRule(),
    ...overrides
  };
}

function createAutomationRule(
  overrides: Partial<AutomationRule> = {}
): AutomationRule {
  return {
    action: "consult",
    budget: { maxRunsPerSession: 1, maxTotalTokensPerSession: 50000 },
    createdAt: "2026-07-12T00:00:00Z",
    enabled: false,
    id: "automation-rule:1",
    name: "Completion check",
    permissions: { allowedTools: [] },
    prompt: "Check the completed task.",
    target: {
      kind: "model",
      modelPlanId: "plan-1",
      requiredCapabilities: []
    },
    trigger: "on_task_complete",
    updatedAt: "2026-07-12T00:00:00Z",
    workspaceId: "workspace-1",
    ...overrides
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
