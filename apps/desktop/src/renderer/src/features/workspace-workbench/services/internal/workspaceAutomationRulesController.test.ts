import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentTarget,
  AutomationRule,
  WorkspaceAgent
} from "@tutti-os/client-tuttid-ts";
import {
  WorkspaceAutomationRulesController,
  type WorkspaceAutomationRulesControllerDependencies
} from "./workspaceAutomationRulesController.ts";
import { createWorkspaceSettingsStore } from "./workspaceSettingsStore.ts";

test("automation rules controller loads workspace rules and the merged target directory", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const controller = new WorkspaceAutomationRulesController({
    client: createClient({
      listAutomationRules: async () => [createAutomationRule()],
      listAgentTargets: async () => [
        createAgentTarget({ id: "local:codex", name: "Codex" }),
        createAgentTarget({
          enabled: false,
          id: "local:disabled",
          name: "Disabled"
        })
      ],
      listWorkspaceAgents: async () => [
        createWorkspaceAgent({ id: "workspace-agent:writer", name: "Writer" }),
        createWorkspaceAgent({
          enabled: false,
          id: "workspace-agent:off",
          name: "Off"
        })
      ]
    }),
    store
  });

  await controller.refresh();

  assert.deepEqual(
    store.automationRules.rules.map((rule) => rule.id),
    ["automation-rule:1"]
  );
  assert.deepEqual(
    store.automationRules.targetOptions.map((option) => option.id),
    ["local:codex", "workspace-agent:writer"]
  );
  assert.equal(store.automationRules.targetOptions[0]?.kind, "builtin");
  assert.equal(store.automationRules.loadFailed, false);
});

test("automation rules controller keeps built-in targets selectable without workspace agents", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const controller = new WorkspaceAutomationRulesController({
    client: createClient({
      listAgentTargets: async () => [
        createAgentTarget({ id: "local:claude-code", name: "Claude Code" })
      ],
      listWorkspaceAgents: async () => []
    }),
    store
  });

  await controller.refresh();
  controller.beginDraft();

  assert.equal(store.automationRules.draft?.targetAgentId, "local:claude-code");
  assert.equal(store.automationRules.draft?.enabled, false);
  assert.equal(store.automationRules.draft?.maxRunsPerSession, "3");
  assert.equal(store.automationRules.draft?.maxTotalTokensPerSession, "200000");
});

test("automation rules controller loads the permission and tool catalogs for the selected target", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const catalogRequests: string[] = [];
  const controller = new WorkspaceAutomationRulesController({
    client: createClient({
      getAutomationTargetCatalog: async (_workspaceID, provider, targetID) => {
        catalogRequests.push(`${provider}:${targetID}`);
        return {
          permissionModes: [
            { id: "workspace-write", label: "Workspace write" }
          ],
          tools: [{ id: "mcpServer:browser", label: "Browser" }]
        };
      },
      listAgentTargets: async () => [
        createAgentTarget({ id: "local:codex", name: "Codex" })
      ],
      listWorkspaceAgents: async () => []
    }),
    store
  });

  await controller.refresh();
  controller.beginDraft();
  // beginDraft preselects the first directory entry and loads its catalog;
  // re-selecting the same target is a no-op.
  await controller.selectDraftTarget("local:codex");

  assert.deepEqual(catalogRequests, ["codex:local:codex"]);
  assert.equal(store.automationRules.targetCatalog?.loading, false);
  assert.deepEqual(store.automationRules.targetCatalog?.permissionModes, [
    { id: "workspace-write", label: "Workspace write" }
  ]);
  assert.deepEqual(store.automationRules.targetCatalog?.tools, [
    { id: "mcpServer:browser", label: "Browser" }
  ]);
});

test("automation rules controller clears incompatible selections when the target changes", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const controller = new WorkspaceAutomationRulesController({
    client: createClient({
      getAutomationTargetCatalog: async (_workspaceID, _provider, targetID) =>
        targetID === "local:codex"
          ? {
              permissionModes: [
                { id: "full-access", label: "Full access" },
                { id: "workspace-write", label: "Workspace write" }
              ],
              tools: [
                { id: "mcpServer:browser", label: "Browser" },
                { id: "mcpServer:terminal", label: "Terminal" }
              ]
            }
          : {
              permissionModes: [
                { id: "workspace-write", label: "Workspace write" }
              ],
              tools: [{ id: "mcpServer:terminal", label: "Terminal" }]
            },
      listAgentTargets: async () => [
        createAgentTarget({ id: "local:codex", name: "Codex" }),
        createAgentTarget({
          id: "local:claude-code",
          name: "Claude Code",
          provider: "claude-code"
        })
      ],
      listWorkspaceAgents: async () => []
    }),
    store
  });

  await controller.refresh();
  controller.beginDraft();
  await controller.selectDraftTarget("local:codex");
  controller.updateDraft({
    allowedTools: ["mcpServer:browser", "mcpServer:terminal"],
    permissionModeId: "full-access"
  });

  await controller.selectDraftTarget("local:claude-code");

  assert.equal(store.automationRules.draft?.targetAgentId, "local:claude-code");
  // full-access is not offered by the new target and must be cleared; the
  // still-compatible terminal tool survives.
  assert.equal(store.automationRules.draft?.permissionModeId, "");
  assert.deepEqual(store.automationRules.draft?.allowedTools, [
    "mcpServer:terminal"
  ]);
});

test("automation rules controller saves the launch rule without an action field", async () => {
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
          target: input.target
        });
      },
      listAgentTargets: async () => [
        createAgentTarget({ id: "local:codex", name: "Codex" })
      ],
      listWorkspaceAgents: async () => [
        createWorkspaceAgent({ id: "workspace-agent:writer", name: "Writer" })
      ]
    }),
    store
  });

  await controller.refresh();
  controller.beginDraft();
  controller.updateDraft({
    allowedTools: ["mcpServer:terminal"],
    enabled: true,
    maxRunsPerSession: "2",
    maxTotalTokensPerSession: "75000",
    name: "Launch follow-up",
    permissionModeId: "workspace-write",
    prompt: "Continue the work.",
    sourceWorkspaceAgentId: "workspace-agent:writer",
    targetAgentId: "workspace-agent:writer"
  });

  await controller.saveDraft();

  assert.deepEqual(requests, [
    {
      budget: {
        maxRunsPerSession: 2,
        maxTotalTokensPerSession: 75000
      },
      enabled: true,
      name: "Launch follow-up",
      permissions: {
        allowedTools: ["mcpServer:terminal"],
        permissionModeId: "workspace-write"
      },
      prompt: "Continue the work.",
      sourceWorkspaceAgentId: "workspace-agent:writer",
      target: {
        kind: "agent",
        requiredCapabilities: [],
        workspaceAgentId: "workspace-agent:writer"
      },
      trigger: "on_task_complete"
    }
  ]);
  assert.equal(store.automationRules.draft, null);
});

test("automation rules controller requires a target agent before saving", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  let createCalls = 0;
  const controller = new WorkspaceAutomationRulesController({
    client: createClient({
      createAutomationRule: async () => {
        createCalls += 1;
        return createAutomationRule();
      },
      listAgentTargets: async () => [],
      listWorkspaceAgents: async () => []
    }),
    store
  });
  await controller.refresh();
  controller.beginDraft();
  controller.updateDraft({ name: "No target" });

  await controller.saveDraft();

  assert.equal(createCalls, 0);
  assert.equal(store.automationRules.feedback?.kind, "requiredFields");
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
      },
      listAgentTargets: async () => [
        createAgentTarget({ id: "local:codex", name: "Codex" })
      ],
      listWorkspaceAgents: async () => []
    }),
    store
  });
  await controller.refresh();
  controller.beginDraft();
  controller.updateDraft({
    maxRunsPerSession: "-1",
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
      createAutomationRule: async () => request.promise,
      listAgentTargets: async () => [
        createAgentTarget({ id: "local:codex", name: "Codex" })
      ],
      listWorkspaceAgents: async () => []
    }),
    store
  });
  await controller.refresh();
  controller.beginDraft();
  controller.updateDraft({ name: "Workspace 1 rule" });

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
    getAutomationTargetCatalog: async () => ({
      permissionModes: [],
      tools: []
    }),
    listAgentTargets: async () => [],
    listAutomationRules: async () => [],
    listWorkspaceAgents: async () => [],
    updateAutomationRule: async () => createAutomationRule(),
    ...overrides
  };
}

function createAutomationRule(
  overrides: Partial<AutomationRule> = {}
): AutomationRule {
  return {
    budget: { maxRunsPerSession: 1, maxTotalTokensPerSession: 50000 },
    createdAt: "2026-07-12T00:00:00Z",
    enabled: false,
    id: "automation-rule:1",
    name: "Launch follow-up",
    permissions: { allowedTools: [] },
    prompt: "Continue the work.",
    target: {
      kind: "agent",
      requiredCapabilities: [],
      workspaceAgentId: "workspace-agent:writer"
    },
    trigger: "on_task_complete",
    updatedAt: "2026-07-12T00:00:00Z",
    workspaceId: "workspace-1",
    ...overrides
  };
}

function createAgentTarget(overrides: Partial<AgentTarget>): AgentTarget {
  return {
    availability: { status: "ready" },
    createdAt: "2026-07-12T00:00:00Z",
    enabled: true,
    iconKey: "codex",
    id: "local:codex",
    kind: "local_process",
    name: "Codex",
    provider: "codex",
    sortOrder: 0,
    source: "system",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides
  } as AgentTarget;
}

function createWorkspaceAgent(
  overrides: Partial<WorkspaceAgent>
): WorkspaceAgent {
  return {
    callConditions: [],
    capabilitiesExplicit: false,
    createdAt: "2026-07-12T00:00:00Z",
    enabled: true,
    harness: {
      agentTargetId: "local:codex",
      available: true,
      enabled: true,
      name: "Codex",
      provider: "codex"
    },
    id: "workspace-agent:writer",
    instructions: "",
    modelFallbacks: [],
    name: "Writer",
    permissions: [],
    purpose: "",
    revision: 1,
    skills: [],
    source: "user",
    tools: [],
    updatedAt: "2026-07-12T00:00:00Z",
    workspaceId: "workspace-1",
    ...overrides
  } as WorkspaceAgent;
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
