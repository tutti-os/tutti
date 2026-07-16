import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTarget } from "@tutti-os/client-tuttid-ts";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type {
  WorkspaceModelPlan,
  WorkspaceModelPlanProtocol
} from "../workspaceSettingsTypes.ts";
import { DesktopWorkspaceSettingsDaemonError } from "./adapters/desktopWorkspaceSettingsClient.ts";
import {
  WorkspaceModelPlansController,
  type WorkspaceModelPlansControllerDependencies
} from "./workspaceModelPlansController.ts";
import { createWorkspaceSettingsStore } from "./workspaceSettingsStore.ts";

type ModelPlansClient = WorkspaceModelPlansControllerDependencies["client"];

test("WorkspaceModelPlansController keeps default refresh Plan-only", async () => {
  let bindingLoads = 0;
  let targetLoads = 0;
  const { controller, store } = createController({
    listModelPlans: async () => [createPlan("plan-1", "openai")],
    listAgentTargets: async () => {
      targetLoads += 1;
      return [createAgentTarget("local:codex", "codex", true, 2)];
    },
    listAgentModelBindings: async () => {
      bindingLoads += 1;
      return [
        {
          agentTargetId: "local:codex",
          defaultModel: "gpt-5.5",
          modelPlanId: "plan-1"
        }
      ];
    }
  });

  await controller.refresh();

  assert.deepEqual(
    store.modelPlans.plans.map((plan) => plan.id),
    ["plan-1"]
  );
  assert.equal(targetLoads, 0);
  assert.equal(bindingLoads, 0);
  assert.equal(store.modelPlans.bindings.agentTargets.length, 0);

  await controller.refreshBindings();

  assert.deepEqual(
    store.modelPlans.bindings.agentTargets.map((target) => target.id),
    ["local:codex"]
  );
  assert.equal(store.modelPlans.bindings.bindings[0]?.modelPlanId, "plan-1");
  assert.equal(targetLoads, 1);
  assert.equal(bindingLoads, 1);
});

test("WorkspaceModelPlansController owns first-use launch assembly and state", async () => {
  const launches: Parameters<
    NonNullable<WorkspaceModelPlansControllerDependencies["launchAgentGui"]>
  >[0][] = [];
  const { controller, store } = createController(
    {
      listModelPlans: async () => [
        {
          ...createPlan("plan-1", "openai"),
          defaultModel: "gpt-5.5",
          name: "OpenAI Plan"
        }
      ],
      listAgentTargets: async () => [
        createAgentTarget("local:codex", "codex", true, 1),
        createAgentTarget("local:claude", "claude_code", true, 2)
      ]
    },
    async (input) => {
      launches.push(input);
      assert.equal(store.modelPlans.firstUseLaunchingPlanID, "plan-1");
      return true;
    }
  );

  await controller.refreshPlans();
  store.agents.harnessTargets = [
    {
      enabled: true,
      id: "local:codex",
      name: "Codex",
      provider: "codex"
    },
    {
      enabled: true,
      id: "local:claude",
      name: "Claude Code",
      provider: "claude_code"
    }
  ];
  await controller.launchFirstUse("plan-1", "local:codex");

  assert.equal(launches.length, 1);
  assert.deepEqual(
    {
      ...launches[0],
      draftPrompt: undefined
    },
    {
      agentTargetId: "local:codex",
      draftPrompt: undefined,
      model: "gpt-5.5",
      modelPlanId: "plan-1",
      openInNewWindow: true,
      provider: "codex",
      workspaceId: "workspace-1"
    }
  );
  assert.match(launches[0]?.draftPrompt ?? "", /OpenAI Plan/);
  assert.equal(store.modelPlans.firstUseLaunchingPlanID, null);
  assert.equal(store.modelPlans.firstUseLaunchFailedPlanID, null);

  await controller.launchFirstUse("plan-1", "local:claude");
  assert.equal(launches.length, 1);
  assert.equal(store.modelPlans.firstUseLaunchFailedPlanID, "plan-1");
});

test("WorkspaceModelPlansController saves a new plan draft", async () => {
  const created: unknown[] = [];
  const detectRequests: unknown[] = [];
  const { controller, store } = createController({
    createModelPlan: async (_workspaceID, input) => {
      created.push(input);
      return {
        ...createPlan("plan-new", input.protocol),
        name: input.name
      };
    },
    detectModelPlan: async (_workspaceID, input) => {
      detectRequests.push(input);
      return { detection: passedCoreDetection(), discoveredModels: [] };
    },
    listModelPlans: async () => [
      {
        ...createPlan("plan-new", "openai"),
        detection: passedCoreDetection(),
        name: "DeepSeek"
      }
    ]
  });

  controller.beginDraft({
    baseUrl: "https://api.deepseek.com",
    models: [
      {
        id: "deepseek-chat",
        name: "deepseek-chat",
        pricing: {
          currency: "USD",
          inputMicrosPerMillion: 140_000,
          outputMicrosPerMillion: 280_000,
          cacheReadMicrosPerMillion: 14_000,
          cacheWriteMicrosPerMillion: 28_000
        }
      }
    ],
    name: "DeepSeek",
    protocol: "openai",
    templateId: "deepseek-openai",
    templateKind: "domestic"
  });
  controller.updateDraft({ apiKey: "sk-test" });
  await controller.detectDraft();
  await controller.saveDraft();

  assert.deepEqual(created, [
    {
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-chat",
      enabled: true,
      models: [
        {
          id: "deepseek-chat",
          name: "deepseek-chat",
          pricing: {
            currency: "USD",
            inputMicrosPerMillion: 140_000,
            outputMicrosPerMillion: 280_000,
            cacheReadMicrosPerMillion: 14_000,
            cacheWriteMicrosPerMillion: 28_000
          },
          tier: "standard"
        }
      ],
      name: "DeepSeek",
      protocol: "openai",
      templateKind: "domestic"
    }
  ]);
  assert.equal(store.modelPlans.draft, null);
  assert.deepEqual(detectRequests, [
    {
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      models: [{ id: "deepseek-chat", name: "deepseek-chat" }],
      protocol: "openai",
      templateKind: "domestic"
    },
    { planId: "plan-new" }
  ]);
  assert.deepEqual(
    store.modelPlans.plans.map((plan) => plan.id),
    ["plan-new"]
  );
});

test("WorkspaceModelPlansController requires a successful connection check before creating", async () => {
  let createCalls = 0;
  const { controller, store } = createController({
    createModelPlan: async () => {
      createCalls += 1;
      throw new Error("unexpected");
    }
  });

  controller.beginDraft({
    baseUrl: "https://api.example.com/v1",
    name: "Example",
    protocol: "openai",
    templateKind: "custom"
  });
  controller.updateDraft({ apiKey: "sk-test" });
  await controller.saveDraft();

  assert.equal(createCalls, 0);
  assert.equal(store.modelPlans.draftFeedback?.kind, "detectionRequired");
  assert.notEqual(store.modelPlans.draft, null);
});

test("WorkspaceModelPlansController blocks a draft save without required fields", async () => {
  let createCalls = 0;
  const { controller, store } = createController({
    createModelPlan: async () => {
      createCalls += 1;
      throw new Error("unexpected");
    }
  });

  controller.beginDraft({
    name: "Custom",
    protocol: "openai",
    templateKind: "custom"
  });
  await controller.saveDraft();

  assert.equal(createCalls, 0);
  assert.equal(store.modelPlans.draftFeedback?.kind, "requiredFields");
  assert.notEqual(store.modelPlans.draft, null);
});

test("WorkspaceModelPlansController keeps the stored key when editing without a new one", async () => {
  const updates: Array<{ apiKey?: string }> = [];
  const { controller, store } = createController({
    listModelPlans: async () => [createPlan("plan-1", "anthropic")],
    updateModelPlan: async (_workspaceID, _planID, input) => {
      updates.push(input);
      return createPlan("plan-1", "anthropic");
    }
  });

  await controller.refreshPlans();
  controller.beginEditPlan("plan-1");
  controller.updateDraft({ name: "Renamed" });
  await controller.saveDraft();

  assert.equal(updates.length, 1);
  assert.equal("apiKey" in (updates[0] ?? {}), false);
  assert.equal(store.modelPlans.draft, null);
});

test("WorkspaceModelPlansController previews references before saving a changed model range", async () => {
  const updates: unknown[] = [];
  const stored = {
    ...createPlan("plan-1", "openai"),
    defaultModel: "gpt-5",
    models: [{ id: "gpt-5", name: "GPT-5", tier: "flagship" as const }]
  };
  const { controller, store } = createController({
    listModelPlanReferences: async () => [
      {
        id: "workspace-agent:reviewer",
        kind: "workspace_agent",
        name: "Reviewer",
        role: "default"
      }
    ],
    listModelPlans: async () => [stored],
    updateModelPlan: async (_workspaceID, _planID, input) => {
      updates.push(input);
      return {
        ...stored,
        defaultModel: input.defaultModel ?? null,
        models: input.models
      };
    }
  });

  await controller.refreshPlans();
  controller.beginEditPlan("plan-1");
  controller.updateDraft({
    defaultModel: "gpt-5-mini",
    models: [{ id: "gpt-5-mini", name: "GPT-5 mini", tier: "economy" }]
  });

  await controller.saveDraft();

  assert.equal(updates.length, 0);
  assert.equal(store.modelPlans.draftSaveImpact?.planID, "plan-1");
  assert.equal(
    store.modelPlans.draftSaveImpact?.references[0]?.name,
    "Reviewer"
  );

  await controller.saveDraft();

  assert.equal(updates.length, 1);
  assert.equal(store.modelPlans.draft, null);
});

test("WorkspaceModelPlansController detects an unsaved draft without a plan id", async () => {
  const detectRequests: unknown[] = [];
  const { controller, store } = createController({
    detectModelPlan: async (_workspaceID, input) => {
      detectRequests.push(input);
      return {
        detection: {
          checkedAt: "2026-07-12T00:00:00Z",
          stages: [{ stage: "network", status: "passed", latencyMs: 12 }]
        },
        discoveredModels: [{ id: "gpt-5.5", name: "gpt-5.5" }]
      };
    }
  });

  controller.beginDraft({
    name: "OpenAI",
    protocol: "openai",
    templateKind: "official_subscription"
  });
  await controller.detectDraft();

  assert.deepEqual(detectRequests, [
    {
      protocol: "openai",
      templateKind: "official_subscription"
    }
  ]);
  assert.equal(store.modelPlans.draftDetection?.stages.length, 1);
  // An empty draft model list is auto-filled from the discovered models.
  assert.deepEqual(
    store.modelPlans.draft?.models.map((model) => model.id),
    ["gpt-5.5"]
  );
  assert.equal(store.modelPlans.draft?.defaultModel, "gpt-5.5");
});

test("WorkspaceModelPlansController detects a saved plan through its plan id", async () => {
  const detectRequests: Array<{ planId?: string }> = [];
  const { controller } = createController({
    listModelPlans: async () => [createPlan("plan-1", "openai")],
    detectModelPlan: async (_workspaceID, input) => {
      detectRequests.push(input);
      return { detection: { stages: [] }, discoveredModels: [] };
    }
  });

  await controller.refreshPlans();
  controller.beginEditPlan("plan-1");
  await controller.detectDraft();

  assert.equal(detectRequests[0]?.planId, "plan-1");
});

test("WorkspaceModelPlansController saves an official subscription without endpoint credentials", async () => {
  const creates: unknown[] = [];
  const { controller, store } = createController({
    createModelPlan: async (_workspaceID, input) => {
      creates.push(input);
      return {
        ...createPlan("plan-native", "openai"),
        baseUrl: null,
        defaultModel: input.defaultModel ?? null,
        hasApiKey: false,
        models: input.models,
        name: input.name
      };
    },
    detectModelPlan: async (_workspaceID, input) => ({
      detection: passedCoreDetection(),
      discoveredModels: input.planId
        ? []
        : [{ id: "gpt-native", name: "GPT Native", tier: "flagship" }]
    }),
    listModelPlans: async () => [
      {
        ...createPlan("plan-native", "openai"),
        baseUrl: null,
        defaultModel: "gpt-native",
        detection: passedCoreDetection(),
        hasApiKey: false,
        models: [{ id: "gpt-native", name: "GPT Native", tier: "flagship" }]
      }
    ]
  });

  controller.beginDraft({
    name: "Codex subscription",
    protocol: "openai",
    templateKind: "official_subscription"
  });
  await controller.detectDraft();
  await controller.saveDraft();

  assert.deepEqual(creates, [
    {
      baseUrl: "",
      defaultModel: "gpt-native",
      enabled: true,
      models: [
        {
          id: "gpt-native",
          name: "GPT Native",
          tier: "flagship"
        }
      ],
      name: "Codex subscription",
      protocol: "openai",
      templateKind: "official_subscription"
    }
  ]);
  assert.equal(store.modelPlans.draft, null);
});

test("WorkspaceModelPlansController blocks deletion while references exist", async () => {
  const { controller, store } = createController({
    listModelPlans: async () => [createPlan("plan-1", "openai")],
    listModelPlanReferences: async () => [
      { id: "local:codex", kind: "agent_target", name: "Codex" }
    ]
  });

  await controller.refreshPlans();
  await controller.requestDeletePlan("plan-1");

  assert.equal(store.modelPlans.confirmingDeletePlanID, null);
  assert.equal(store.modelPlans.deleteBlock?.planID, "plan-1");
  assert.equal(store.modelPlans.deleteBlock?.references[0]?.name, "Codex");
});

test("WorkspaceModelPlansController confirms deletion when nothing references the plan", async () => {
  const deleted: string[] = [];
  const { controller, store } = createController({
    listModelPlans: async () => [createPlan("plan-1", "openai")],
    listModelPlanReferences: async () => [],
    deleteModelPlan: async (_workspaceID, planID) => {
      deleted.push(planID);
    }
  });

  await controller.refreshPlans();
  await controller.requestDeletePlan("plan-1");
  assert.equal(store.modelPlans.confirmingDeletePlanID, "plan-1");

  await controller.confirmDeletePlan("plan-1");

  assert.deepEqual(deleted, ["plan-1"]);
  assert.deepEqual(store.modelPlans.plans, []);
  assert.equal(store.modelPlans.confirmingDeletePlanID, null);
});

test("WorkspaceModelPlansController surfaces a 409 referenced delete as a block", async () => {
  const { controller, store } = createController({
    listModelPlans: async () => [createPlan("plan-1", "openai")],
    deleteModelPlan: async () => {
      throw new DesktopWorkspaceSettingsDaemonError(
        409,
        "model_plan_referenced"
      );
    },
    listModelPlanReferences: async () => [
      { id: "local:codex", kind: "agent_target", name: "Codex" }
    ]
  });

  await controller.refreshPlans();
  await controller.confirmDeletePlan("plan-1");

  assert.deepEqual(
    store.modelPlans.plans.map((plan) => plan.id),
    ["plan-1"]
  );
  assert.equal(store.modelPlans.deleteBlock?.planID, "plan-1");
});

test("WorkspaceModelPlansController persists agent bindings and clears them", async () => {
  const puts: Array<{
    agentTargetID: string;
    input: { defaultModel?: string | null; modelPlanId?: string | null };
  }> = [];
  const { controller, store } = createController({
    setAgentModelBinding: async (_workspaceID, agentTargetID, input) => {
      puts.push({ agentTargetID, input });
      return {
        agentTargetId: agentTargetID,
        defaultModel: input.defaultModel ?? null,
        modelPlanId: input.modelPlanId ?? null
      };
    }
  });

  await controller.setAgentBinding("local:codex", {
    defaultModel: "gpt-5.5",
    modelPlanID: "plan-1"
  });
  await controller.setAgentBinding("local:codex", {
    defaultModel: null,
    modelPlanID: null
  });

  assert.deepEqual(
    puts.map((put) => put.input),
    [
      { defaultModel: "gpt-5.5", modelPlanId: "plan-1", modelPolicyId: null },
      { defaultModel: null, modelPlanId: null, modelPolicyId: null }
    ]
  );
  assert.equal(
    store.modelPlans.bindings.bindings.find(
      (binding) => binding.agentTargetId === "local:codex"
    )?.modelPlanId,
    null
  );
});

test("WorkspaceModelPlansController records a failed enable toggle inline", async () => {
  const { controller, store } = createController({
    listModelPlans: async () => [createPlan("plan-1", "openai")],
    setModelPlanEnabled: async () => {
      throw new Error("nope");
    }
  });

  await controller.refreshPlans();
  await controller.setPlanEnabled("plan-1", false);

  assert.equal(store.modelPlans.planFeedback["plan-1"]?.kind, "toggleFailed");
  assert.equal(store.modelPlans.plans[0]?.enabled, true);
});

function createController(
  overrides: Partial<ModelPlansClient>,
  launchAgentGui?: WorkspaceModelPlansControllerDependencies["launchAgentGui"]
): {
  controller: WorkspaceModelPlansController;
  notifications: string[];
  store: ReturnType<typeof createWorkspaceSettingsStore>;
} {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const notifications: string[] = [];
  const controller = new WorkspaceModelPlansController({
    client: createModelPlansClient(overrides),
    launchAgentGui,
    notifications: createNotificationRecorder(notifications),
    store
  });
  return { controller, notifications, store };
}

function createModelPlansClient(
  overrides: Partial<ModelPlansClient>
): ModelPlansClient {
  return {
    createModelPlan: async () => {
      throw new Error("not used");
    },
    deleteModelPlan: async () => {},
    detectModelPlan: async () => ({
      detection: { stages: [] },
      discoveredModels: []
    }),
    duplicateModelPlan: async () => {
      throw new Error("not used");
    },
    listAgentModelBindings: async () => [],
    listAgentTargets: async () => [],
    listModelPlanReferences: async () => [],
    listModelPlans: async () => [],
    setAgentModelBinding: async () => {
      throw new Error("not used");
    },
    setModelPlanEnabled: async () => {
      throw new Error("not used");
    },
    updateModelPlan: async () => {
      throw new Error("not used");
    },
    ...overrides
  };
}

function createPlan(
  id: string,
  protocol: WorkspaceModelPlanProtocol
): WorkspaceModelPlan {
  return {
    baseUrl:
      protocol === "openai"
        ? "https://api.openai.com/v1"
        : "https://api.anthropic.com/v1",
    createdAt: "2026-07-12T00:00:00Z",
    defaultModel: null,
    detection: { stages: [] },
    enabled: true,
    firstUse: { status: "pending" },
    hasApiKey: true,
    id,
    models: [],
    name: id,
    protocol,
    billingMode: "subscription_quota",
    status: "pending_first_use",
    templateKind: "official_subscription",
    updatedAt: "2026-07-12T00:00:00Z",
    workspaceId: "workspace-1"
  };
}

function passedCoreDetection() {
  return {
    checkedAt: "2026-07-12T00:00:00Z",
    stages: [
      { stage: "network" as const, status: "passed" as const },
      { stage: "auth" as const, status: "passed" as const },
      { stage: "model_discovery" as const, status: "passed" as const },
      { stage: "inference" as const, status: "passed" as const },
      { stage: "agent_runtime" as const, status: "pending" as const }
    ]
  };
}

function createAgentTarget(
  id: string,
  provider: AgentTarget["provider"],
  enabled: boolean,
  sortOrder: number
): AgentTarget {
  return {
    createdAtUnixMs: 1,
    enabled,
    iconKey: provider,
    id,
    launchRef: { provider, type: "builtin_local" },
    name: id,
    provider,
    sortOrder,
    source: "system",
    updatedAtUnixMs: 1
  };
}

function createNotificationRecorder(items: string[]): NotificationService {
  return {
    _serviceBrand: undefined,
    error(input) {
      items.push(input.title);
    },
    info() {},
    notify(input) {
      items.push(input.title);
    },
    success() {},
    warning(input) {
      items.push(input.title);
    }
  };
}
