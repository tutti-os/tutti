import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProviderComposerOptionsResponse,
  AgentTarget,
  AutomationRule,
  WorkspaceAgentDraftGeneration
} from "@tutti-os/client-tuttid-ts";
import type { WorkspaceAgentDefinition } from "../workspaceSettingsTypes.ts";
import {
  parseWorkspaceAgentList,
  WorkspaceAgentsController,
  type WorkspaceAgentsControllerDependencies
} from "./workspaceAgentsController.ts";
import { createWorkspaceSettingsStore } from "./workspaceSettingsStore.ts";

test("workspace agents controller loads explicit Agents and system Harnesses", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const controller = new WorkspaceAgentsController({
    client: createClient({
      listAgentTargets: async () => [
        createAgentTarget("user:shared", "user", 1),
        createAgentTarget("local:codex", "system", 20),
        createAgentTarget("local:claude-code", "system", 10)
      ],
      listWorkspaceAgents: async () => [createWorkspaceAgent()]
    }),
    store
  });

  await controller.refresh();

  assert.deepEqual(
    store.agents.agents.map((agent) => agent.id),
    ["workspace-agent:1"]
  );
  assert.deepEqual(
    store.agents.harnessTargets.map((target) => target.id),
    ["local:claude-code", "local:codex"]
  );
  assert.equal(store.agents.loadFailed, false);
});

test("workspace agents controller ignores a stale workspace refresh", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const firstRequest = createDeferred<WorkspaceAgentDefinition[]>();
  const controller = new WorkspaceAgentsController({
    client: createClient({
      listWorkspaceAgents: (workspaceID) =>
        workspaceID === "workspace-1"
          ? firstRequest.promise
          : Promise.resolve([
              createWorkspaceAgent({
                agentTargetId: "workspace-agent:2",
                id: "workspace-agent:2",
                name: "Workspace 2 Agent",
                workspaceId: "workspace-2"
              })
            ])
    }),
    store
  });

  const staleRefresh = controller.refresh();
  store.workspaceID = "workspace-2";
  controller.reset();
  await controller.refresh();
  firstRequest.resolve([createWorkspaceAgent()]);
  await staleRefresh;

  assert.deepEqual(
    store.agents.agents.map((agent) => agent.id),
    ["workspace-agent:2"]
  );
});

test("workspace agents controller creates one Agent from the complete draft", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.agents.harnessTargets = [
    {
      enabled: true,
      id: "local:codex",
      name: "Codex",
      provider: "codex"
    }
  ];
  const requests: unknown[] = [];
  let directoryRefreshes = 0;
  const controller = new WorkspaceAgentsController({
    client: createClient({
      createWorkspaceAgent: async (_workspaceID, input) => {
        requests.push(input);
        return createWorkspaceAgent({
          defaultModel: input.defaultModel,
          enabled: input.enabled,
          instructions: input.instructions,
          modelPlanId: input.modelPlanId,
          name: input.name,
          permissions: input.permissions,
          purpose: input.purpose,
          skills: input.skills,
          tools: input.tools
        });
      }
    }),
    onWorkspaceAgentsChanged: () => {
      directoryRefreshes += 1;
    },
    store
  });
  controller.beginDraft();
  controller.updateDraft({
    callConditions: "Before release\nBefore release\nOn architecture risk",
    defaultModel: "gpt-5",
    instructions: "Review carefully",
    modelFallbacks: [],
    modelPlanId: "plan-1",
    name: "Reviewer",
    permissions: "workspace.read\nworkspace.read\nnetwork.read",
    purpose: "Review changes",
    capabilitiesExplicit: true,
    skills: "react\na11y",
    tools: "terminal\nbrowser"
  });

  await controller.saveDraft();

  assert.deepEqual(requests, [
    {
      callConditions: ["Before release", "On architecture risk"],
      capabilitiesExplicit: true,
      defaultModel: "gpt-5",
      enabled: true,
      harnessAgentTargetId: "local:codex",
      instructions: "Review carefully",
      modelFallbacks: [],
      modelPlanId: "plan-1",
      name: "Reviewer",
      permissions: ["workspace.read", "network.read"],
      purpose: "Review changes",
      skills: ["react", "a11y"],
      tools: ["terminal", "browser"]
    }
  ]);
  assert.equal(store.agents.draft, null);
  assert.equal(store.agents.agents[0]?.name, "Reviewer");
  assert.equal(directoryRefreshes, 1);
});

test("workspace agents controller generates into the form without persisting", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  let generationInput: unknown;
  let agentWrites = 0;
  const controller = new WorkspaceAgentsController({
    client: createClient({
      createWorkspaceAgent: async () => {
        agentWrites += 1;
        return createWorkspaceAgent();
      },
      generateWorkspaceAgentDraft: async (_workspaceID, input) => {
        generationInput = input;
        return createGeneratedDraft();
      }
    }),
    store
  });
  controller.beginDraft();
  controller.updateDraft({
    defaultModel: "gpt-5",
    generationRequirements: "Review releases",
    harnessAgentTargetId: "local:codex",
    modelPlanId: "plan-1"
  });

  await controller.generateDraft();

  assert.deepEqual(generationInput, {
    harnessAgentTargetId: "local:codex",
    model: "gpt-5",
    modelPlanId: "plan-1",
    requirements: "Review releases"
  });
  assert.equal(agentWrites, 0);
  assert.equal(store.agents.draft?.name, "Release Reviewer");
  assert.equal(store.agents.draft?.instructions, "Review evidence.");
  assert.equal(store.agents.draft?.callConditions, "Use before a release.");
  assert.equal(store.agents.draft?.generatedAutomationRules.length, 1);
  assert.equal(store.agents.draft?.capabilitiesExplicit, true);
});

test("workspace agents controller saves generated automation suggestions disabled", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.agents.harnessTargets = [
    {
      enabled: true,
      id: "local:codex",
      name: "Codex",
      provider: "codex"
    }
  ];
  const ruleWrites: unknown[] = [];
  const controller = new WorkspaceAgentsController({
    client: createClient({
      createAutomationRule: async (_workspaceID, input) => {
        ruleWrites.push(input);
        return createAutomationRule(input);
      },
      createWorkspaceAgent: async (_workspaceID, input) =>
        createWorkspaceAgent({
          id: "workspace-agent:generated",
          agentTargetId: "workspace-agent:generated",
          name: input.name,
          purpose: input.purpose
        })
    }),
    store
  });
  controller.beginDraft();
  controller.updateDraft({
    modelPlanId: "plan-1",
    name: "Release Reviewer",
    purpose: "Review release readiness"
  });
  controller.updateDraft({
    generatedAutomationRules: createGeneratedDraft().automationRules
  });

  await controller.saveDraft();

  assert.equal(ruleWrites.length, 1);
  assert.deepEqual(ruleWrites[0], {
    action: "consult",
    budget: { maxRunsPerSession: 1, maxTotalTokensPerSession: 50000 },
    enabled: false,
    name: "Completion review",
    permissions: { allowedTools: [], permissionModeId: null },
    prompt: "Return VERDICT: PASS or VERDICT: FAIL.",
    sourceWorkspaceAgentId: "workspace-agent:generated",
    target: {
      kind: "model",
      model: "gpt-5",
      modelPlanId: "plan-1",
      requiredCapabilities: []
    },
    trigger: "on_task_complete"
  });
  assert.equal(store.agents.draft, null);
  assert.equal(store.automationRules.rules[0]?.enabled, false);
});

test("workspace agents controller sends null model fields when an edit clears its plan", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.agents.agents = [createWorkspaceAgent()];
  const requests: unknown[] = [];
  const controller = new WorkspaceAgentsController({
    client: createClient({
      updateWorkspaceAgent: async (_workspaceID, _agentID, input) => {
        requests.push(input);
        return createWorkspaceAgent({
          defaultModel: null,
          enabled: false,
          modelPlanId: null
        });
      }
    }),
    store
  });

  controller.beginEditAgent("workspace-agent:1");
  controller.updateDraft({
    defaultModel: "",
    enabled: false,
    modelPlanId: ""
  });
  await controller.saveDraft();

  assert.equal(requests.length, 1);
  const request = requests[0] as {
    defaultModel: string | null;
    enabled: boolean;
    modelPlanId: string | null;
  };
  assert.equal(request.defaultModel, null);
  assert.equal(request.modelPlanId, null);
  assert.equal(request.enabled, false);
});

test("workspace agents controller does not apply a stale save to a new workspace", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const request = createDeferred<WorkspaceAgentDefinition>();
  let directoryRefreshes = 0;
  const controller = new WorkspaceAgentsController({
    client: createClient({
      createWorkspaceAgent: async () => request.promise
    }),
    onWorkspaceAgentsChanged: () => {
      directoryRefreshes += 1;
    },
    store
  });
  controller.beginDraft();
  controller.updateDraft({
    harnessAgentTargetId: "local:codex",
    name: "Workspace 1 Agent"
  });

  const save = controller.saveDraft();
  store.workspaceID = "workspace-2";
  controller.reset();
  store.agents.agents = [
    createWorkspaceAgent({
      agentTargetId: "workspace-agent:2",
      id: "workspace-agent:2",
      name: "Workspace 2 Agent",
      workspaceId: "workspace-2"
    })
  ];
  request.resolve(createWorkspaceAgent({ name: "Workspace 1 Agent" }));
  await save;

  assert.deepEqual(
    store.agents.agents.map((agent) => agent.id),
    ["workspace-agent:2"]
  );
  assert.equal(directoryRefreshes, 0);
});

test("workspace agents controller deletes the selected Agent and refreshes the directory", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.agents.agents = [createWorkspaceAgent()];
  const deleted: string[] = [];
  let directoryRefreshes = 0;
  const controller = new WorkspaceAgentsController({
    client: createClient({
      deleteWorkspaceAgent: async (_workspaceID, agentID) => {
        deleted.push(agentID);
      }
    }),
    onWorkspaceAgentsChanged: () => {
      directoryRefreshes += 1;
    },
    store
  });

  controller.requestDeleteAgent("workspace-agent:1");
  await controller.confirmDeleteAgent("workspace-agent:1");

  assert.deepEqual(deleted, ["workspace-agent:1"]);
  assert.deepEqual(store.agents.agents, []);
  assert.equal(store.agents.confirmingDeleteAgentID, null);
  assert.equal(directoryRefreshes, 1);
});

test("workspace agents controller does not apply a stale delete to a new workspace", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.agents.agents = [createWorkspaceAgent()];
  const request = createDeferred<void>();
  let directoryRefreshes = 0;
  const controller = new WorkspaceAgentsController({
    client: createClient({
      deleteWorkspaceAgent: async () => request.promise
    }),
    onWorkspaceAgentsChanged: () => {
      directoryRefreshes += 1;
    },
    store
  });

  controller.requestDeleteAgent("workspace-agent:1");
  const deletion = controller.confirmDeleteAgent("workspace-agent:1");
  store.workspaceID = "workspace-2";
  controller.reset();
  store.agents.agents = [
    createWorkspaceAgent({
      agentTargetId: "workspace-agent:2",
      id: "workspace-agent:2",
      name: "Workspace 2 Agent",
      workspaceId: "workspace-2"
    })
  ];
  request.resolve(undefined);
  await deletion;

  assert.deepEqual(
    store.agents.agents.map((agent) => agent.id),
    ["workspace-agent:2"]
  );
  assert.equal(directoryRefreshes, 0);
});

test("workspace agents controller adds the daemon recommended compatible fallback", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.modelPlans.plans = [
    {
      id: "plan-primary",
      workspaceId: "workspace-1",
      name: "Primary",
      templateKind: "custom",
      billingMode: "api_metered",
      protocol: "openai",
      hasApiKey: true,
      models: [
        {
          id: "vision-primary",
          name: "Vision Primary",
          capabilities: ["vision", "reasoning"]
        }
      ],
      defaultModel: "vision-primary",
      enabled: true,
      status: "ready",
      detection: { stages: [] },
      firstUse: { status: "completed" },
      createdAt: "2026-07-12T00:00:00Z",
      updatedAt: "2026-07-12T00:00:00Z"
    }
  ];
  let recommendationInput: unknown;
  const controller = new WorkspaceAgentsController({
    client: createClient({
      recommendWorkspaceModels: async (_workspaceID, input) => {
        recommendationInput = input;
        return [
          {
            planId: "plan-primary",
            planName: "Primary",
            billingMode: "api_metered",
            modelId: "vision-primary",
            modelName: "Vision Primary",
            capabilities: ["vision", "reasoning"],
            status: "ready",
            rank: 1,
            reasons: ["status:ready"]
          },
          {
            planId: "plan-fallback",
            planName: "Fallback",
            billingMode: "api_metered",
            modelId: "vision-fallback",
            modelName: "Vision Fallback",
            capabilities: ["vision", "reasoning"],
            status: "ready",
            rank: 2,
            reasons: ["status:ready"]
          }
        ];
      }
    }),
    store
  });
  controller.beginDraft();
  controller.updateDraft({
    defaultModel: "vision-primary",
    modelPlanId: "plan-primary"
  });

  await controller.addRecommendedFallback();

  assert.deepEqual(recommendationInput, {
    limit: 100,
    requiredCapabilities: ["vision", "reasoning"]
  });
  assert.deepEqual(store.agents.draft?.modelFallbacks, [
    { modelPlanId: "plan-fallback", model: "vision-fallback" }
  ]);
  assert.equal(store.agents.feedback, null);
});

test("parseWorkspaceAgentList trims, removes blanks, and keeps stable uniqueness", () => {
  assert.deepEqual(parseWorkspaceAgentList(" alpha \n\n beta\nalpha "), [
    "alpha",
    "beta"
  ]);
});

test("workspace agents controller loads the selected Harness capability catalog", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.agents.harnessTargets = [
    { enabled: true, id: "local:codex", name: "Codex", provider: "codex" }
  ];
  const requests: unknown[] = [];
  const controller = new WorkspaceAgentsController({
    client: createClient({
      getAgentProviderComposerOptions: async (
        workspaceID,
        provider,
        agentTargetID
      ) => {
        requests.push({ agentTargetID, provider, workspaceID });
        return createComposerOptions();
      }
    }),
    store
  });

  controller.beginDraft();
  await controller.refreshCapabilityCatalog();

  assert.deepEqual(requests.at(-1), {
    agentTargetID: "local:codex",
    provider: "codex",
    workspaceID: "workspace-1"
  });
  assert.deepEqual(
    store.agents.capabilityCatalog.map((option) => option.id),
    ["skill:reviewer", "connector:github"]
  );
  assert.equal(store.agents.capabilityCatalogLoadFailed, false);
});

function createClient(
  overrides: Partial<WorkspaceAgentsControllerDependencies["client"]> = {}
): WorkspaceAgentsControllerDependencies["client"] {
  return {
    createAutomationRule: async (_workspaceID, input) =>
      createAutomationRule(input),
    createWorkspaceAgent: async () => createWorkspaceAgent(),
    deleteWorkspaceAgent: async () => undefined,
    getAgentProviderComposerOptions: async () => createComposerOptions(),
    listAgentTargets: async () => [],
    listWorkspaceAgents: async () => [],
    generateWorkspaceAgentDraft: async () => createGeneratedDraft(),
    recommendWorkspaceModels: async () => [],
    updateWorkspaceAgent: async () => createWorkspaceAgent(),
    ...overrides
  };
}

function createGeneratedDraft(): WorkspaceAgentDraftGeneration {
  return {
    automationRules: [
      {
        action: "consult",
        maxRunsPerSession: 1,
        maxTotalTokensPerSession: 50000,
        model: "gpt-5",
        modelPlanId: "plan-1",
        name: "Completion review",
        prompt: "Return VERDICT: PASS or VERDICT: FAIL.",
        trigger: "on_task_complete"
      }
    ],
    callConditions: ["Use before a release."],
    instructions: "Review evidence.",
    name: "Release Reviewer",
    purpose: "Review release readiness",
    skills: ["code-review"],
    usage: { inputTokens: 20, outputTokens: 10 },
    usedModel: "gpt-5",
    usedModelPlanId: "plan-1"
  };
}

function createComposerOptions(): AgentProviderComposerOptionsResponse {
  const emptyConfig = {
    configurable: false,
    currentValue: "",
    defaultValue: "",
    options: []
  };
  return {
    behavior: {
      collapseModelOptionsToLatest: false,
      modelOptionsAuthoritative: false,
      planModeExclusiveWithPermissionMode: false,
      prewarmDraftSession: false,
      refreshModelOptionsAfterSettings: false
    },
    commands: [],
    capabilityCatalog: [
      {
        id: "connector:github",
        invocation: "promptItem",
        kind: "connector",
        label: "GitHub",
        name: "github",
        status: "available"
      },
      {
        id: "skill:reviewer",
        invocation: "promptItem",
        kind: "skill",
        label: "Reviewer",
        name: "reviewer",
        status: "available"
      }
    ],
    effectiveSettings: {},
    modelConfig: emptyConfig,
    permissionConfig: {
      configurable: false,
      defaultValue: "",
      modes: []
    },
    provider: "codex",
    reasoningConfig: emptyConfig,
    reasoningOptionsByModel: {},
    runtimeContext: {},
    skills: []
  };
}

function createAutomationRule(
  input: Parameters<
    WorkspaceAgentsControllerDependencies["client"]["createAutomationRule"]
  >[1]
): AutomationRule {
  return {
    ...input,
    createdAt: "2026-07-12T00:00:00Z",
    id: "automation-rule:generated",
    sourceWorkspaceAgentId: input.sourceWorkspaceAgentId ?? null,
    updatedAt: "2026-07-12T00:00:00Z",
    workspaceId: "workspace-1"
  };
}

function createAgentTarget(
  id: string,
  source: AgentTarget["source"],
  sortOrder: number
): AgentTarget {
  const provider = id.includes("claude") ? "claude-code" : "codex";
  return {
    createdAtUnixMs: 1,
    enabled: true,
    iconKey: null,
    id,
    launchRef: { provider, type: "builtin_local" },
    name: id,
    provider,
    sortOrder,
    source,
    updatedAtUnixMs: 1
  };
}

function createWorkspaceAgent(
  overrides: Partial<WorkspaceAgentDefinition> = {}
): WorkspaceAgentDefinition {
  return {
    agentTargetId: "workspace-agent:1",
    capabilitiesExplicit: true,
    callConditions: ["Use when a review is needed"],
    createdAt: "2026-07-12T00:00:00Z",
    defaultModel: "gpt-5",
    enabled: true,
    harness: {
      agentTargetId: "local:codex",
      available: true,
      enabled: true,
      name: "Codex",
      provider: "codex"
    },
    id: "workspace-agent:1",
    instructions: "Review carefully",
    modelPlanId: "plan-1",
    name: "Reviewer",
    permissions: ["workspace.read"],
    purpose: "Review changes",
    revision: 1,
    skills: ["react"],
    source: "user",
    tools: ["terminal"],
    updatedAt: "2026-07-12T00:00:00Z",
    workspaceId: "workspace-1",
    ...overrides,
    modelFallbacks: overrides.modelFallbacks ?? []
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
