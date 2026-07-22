import assert from "node:assert/strict";
import test from "node:test";
import {
  TuttidProtocolError,
  type AgentTarget
} from "@tutti-os/client-tuttid-ts";
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
          workspaceId: "workspace-1",
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
    name: "DeepSeek",
    protocol: "openai",
    templateId: "deepseek-openai",
    templateKind: "domestic"
  });
  assert.deepEqual(store.modelPlans.draft?.models, [{ id: "", name: "" }]);
  assert.equal(store.modelPlans.draft?.defaultModel, "");
  controller.updateDraft({
    apiKey: "sk-test",
    models: [
      {
        capabilities: ["reasoning"],
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
    ]
  });
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
          capabilities: ["reasoning"],
          id: "deepseek-chat",
          name: "deepseek-chat"
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
      protocol: "openai"
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
  controller.updateDraft({
    apiKey: "sk-test",
    models: [{ id: "example-model", name: "Example model" }]
  });
  await controller.saveDraft();

  assert.equal(createCalls, 0);
  assert.equal(store.modelPlans.draftFeedback?.kind, "detectionRequired");
  assert.notEqual(store.modelPlans.draft, null);
});

test("WorkspaceModelPlansController blocks saving an endpoint plan without models", async () => {
  let createCalls = 0;
  const { controller, store } = createController({
    createModelPlan: async () => {
      createCalls += 1;
      throw new Error("unexpected");
    },
    detectModelPlan: async () => ({
      // The daemon can pass detection for a model-less draft by probing the
      // first discovered candidate; that must not make the draft saveable.
      detection: passedCoreDetection(),
      discoveredModels: [{ id: "candidate", name: "Candidate" }]
    })
  });

  controller.beginDraft({
    baseUrl: "https://api.example.com/v1",
    name: "Example",
    protocol: "openai",
    templateKind: "custom"
  });
  controller.updateDraft({ apiKey: "sk-test" });
  await controller.detectDraft();
  await controller.saveDraft();

  assert.equal(createCalls, 0);
  assert.equal(store.modelPlans.draftFeedback?.kind, "requiredFields");
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
  const updates: Array<{ apiKey?: string | null }> = [];
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
        kind: "workspace_app",
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
        models: input.models ?? stored.models
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

test("WorkspaceModelPlansController keeps 100 discovered models out of the draft selection", async () => {
  const detectRequests: unknown[] = [];
  const discoveredModels = Array.from({ length: 100 }, (_, index) => ({
    id: `gpt-${index + 1}`,
    name: `GPT ${index + 1}`
  }));
  const { controller, store } = createController({
    detectModelPlan: async (_workspaceID, input) => {
      detectRequests.push(input);
      return {
        detection: {
          checkedAt: "2026-07-12T00:00:00Z",
          stages: [{ stage: "network", status: "passed", latencyMs: 12 }]
        },
        discoveredModels
      };
    }
  });

  controller.beginDraft({
    name: "OpenAI",
    protocol: "openai",
    templateKind: "official_subscription"
  });
  await controller.detectDraft();

  assert.deepEqual(detectRequests, [{ protocol: "openai" }]);
  assert.equal(store.modelPlans.draftDetection?.stages.length, 1);
  assert.deepEqual(store.modelPlans.draft?.models, [{ id: "", name: "" }]);
  assert.equal(store.modelPlans.draft?.defaultModel, "");
  assert.equal(store.modelPlans.draftDiscoveredModels.length, 100);
  assert.equal(store.modelPlans.draftDiscoveredModels[99]?.id, "gpt-100");
});

test("WorkspaceModelPlansController fetches draft models into the candidate catalog only", async () => {
  const detectRequests: unknown[] = [];
  const { controller, store } = createController({
    detectModelPlan: async (_workspaceID, input) => {
      detectRequests.push(input);
      return {
        detection: passedCoreDetection(),
        discoveredModels: [
          { id: "model-a", name: "Model A" },
          { id: "model-b", name: "Model B" }
        ]
      };
    }
  });

  controller.beginDraft({
    baseUrl: "https://api.example.com/v1",
    name: "Example",
    protocol: "openai",
    templateKind: "custom"
  });
  controller.updateDraft({ apiKey: "sk-test" });
  await controller.fetchDraftModels();

  assert.deepEqual(detectRequests, [
    {
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
      protocol: "openai"
    }
  ]);
  assert.deepEqual(
    store.modelPlans.draftDiscoveredModels.map((model) => model.id),
    ["model-a", "model-b"]
  );
  // Discovery must never stand in for the final connection check gate.
  assert.equal(store.modelPlans.draftDetection, null);
  assert.deepEqual(store.modelPlans.draft?.models, [{ id: "", name: "" }]);
  assert.equal(store.modelPlans.fetchingDraftModels, false);
  assert.equal(store.modelPlans.draftFeedback, null);
});

test("WorkspaceModelPlansController requires endpoint fields before fetching models", async () => {
  let detectCalls = 0;
  const { controller, store } = createController({
    detectModelPlan: async () => {
      detectCalls += 1;
      return { detection: { stages: [] }, discoveredModels: [] };
    }
  });

  controller.beginDraft({
    name: "Custom",
    protocol: "openai",
    templateKind: "custom"
  });
  await controller.fetchDraftModels();

  assert.equal(detectCalls, 0);
  assert.equal(store.modelPlans.draftFeedback?.kind, "requiredFields");
});

test("WorkspaceModelPlansController surfaces a failed model fetch", async () => {
  const { controller, store } = createController({
    detectModelPlan: async () => {
      throw new Error("unreachable endpoint");
    }
  });

  controller.beginDraft({
    baseUrl: "https://api.example.com/v1",
    name: "Example",
    protocol: "openai",
    templateKind: "custom"
  });
  controller.updateDraft({ apiKey: "sk-test" });
  await controller.fetchDraftModels();

  assert.equal(store.modelPlans.draftFeedback?.kind, "fetchModelsFailed");
  assert.equal(store.modelPlans.fetchingDraftModels, false);
  assert.deepEqual(store.modelPlans.draftDiscoveredModels, []);
});

test("WorkspaceModelPlansController flags a fetch whose discovery stage failed", async () => {
  const { controller, store } = createController({
    detectModelPlan: async () => ({
      detection: {
        checkedAt: "2026-07-17T00:00:00Z",
        stages: [
          { stage: "network" as const, status: "passed" as const },
          { stage: "auth" as const, status: "failed" as const }
        ]
      },
      discoveredModels: []
    })
  });

  controller.beginDraft({
    baseUrl: "https://api.example.com/v1",
    name: "Example",
    protocol: "openai",
    templateKind: "custom"
  });
  controller.updateDraft({ apiKey: "sk-bad" });
  await controller.fetchDraftModels();

  assert.equal(store.modelPlans.draftFeedback?.kind, "fetchModelsFailed");
  assert.deepEqual(store.modelPlans.draftDiscoveredModels, []);
});

test("WorkspaceModelPlansController discards an in-flight detection when the draft changes", async () => {
  let resolveDetect!: (value: {
    detection: ReturnType<typeof passedCoreDetection>;
    discoveredModels: { id: string; name: string }[];
  }) => void;
  const pendingDetect = new Promise<{
    detection: ReturnType<typeof passedCoreDetection>;
    discoveredModels: { id: string; name: string }[];
  }>((resolve) => {
    resolveDetect = resolve;
  });
  const { controller, store } = createController({
    detectModelPlan: async () => await pendingDetect
  });

  controller.beginDraft({
    baseUrl: "https://api.example.com/v1",
    name: "First",
    protocol: "openai",
    templateKind: "custom"
  });
  controller.updateDraft({ apiKey: "sk-test" });
  const inFlight = controller.detectDraft();

  // The user abandons the endpoint draft for a native-login draft while the
  // check is still in flight. A stale passed detection must not attach to
  // the new draft, where it would unlock the save gate.
  controller.beginDraft({
    name: "Codex subscription",
    protocol: "openai",
    templateKind: "official_subscription"
  });
  resolveDetect({
    detection: passedCoreDetection(),
    discoveredModels: [{ id: "stale-model", name: "Stale model" }]
  });
  await inFlight;

  assert.equal(store.modelPlans.draftDetection, null);
  assert.deepEqual(store.modelPlans.draftDiscoveredModels, []);
  assert.equal(store.modelPlans.detecting, false);
  assert.equal(store.modelPlans.draftFeedback, null);
});

test("WorkspaceModelPlansController discards an in-flight model fetch when the draft changes", async () => {
  let resolveDetect!: (value: {
    detection: ReturnType<typeof passedCoreDetection>;
    discoveredModels: { id: string; name: string }[];
  }) => void;
  const pendingDetect = new Promise<{
    detection: ReturnType<typeof passedCoreDetection>;
    discoveredModels: { id: string; name: string }[];
  }>((resolve) => {
    resolveDetect = resolve;
  });
  const { controller, store } = createController({
    detectModelPlan: async () => await pendingDetect
  });

  controller.beginDraft({
    baseUrl: "https://api.example.com/v1",
    name: "First",
    protocol: "openai",
    templateKind: "custom"
  });
  controller.updateDraft({ apiKey: "sk-test" });
  const inFlight = controller.fetchDraftModels();

  controller.beginDraft({
    baseUrl: "https://api.other.com/v1",
    name: "Second",
    protocol: "openai",
    templateKind: "custom"
  });
  resolveDetect({
    detection: passedCoreDetection(),
    discoveredModels: [{ id: "stale-model", name: "Stale model" }]
  });
  await inFlight;

  assert.deepEqual(store.modelPlans.draftDiscoveredModels, []);
  assert.equal(store.modelPlans.fetchingDraftModels, false);
  assert.equal(store.modelPlans.draftFeedback, null);
});

test("WorkspaceModelPlansController classifies an unreachable-endpoint fetch as failed", async () => {
  const { controller, store } = createController({
    detectModelPlan: async () => ({
      // Real chain for an invalid Base URL: network fails, so discovery is
      // skipped (never failed). Skipped must not read as an empty success.
      detection: {
        checkedAt: "2026-07-17T00:00:00Z",
        stages: [
          { stage: "network" as const, status: "failed" as const },
          { stage: "auth" as const, status: "skipped" as const },
          { stage: "model_discovery" as const, status: "skipped" as const },
          { stage: "inference" as const, status: "skipped" as const }
        ]
      },
      discoveredModels: []
    })
  });

  controller.beginDraft({
    baseUrl: "https://invalid.example.invalid/v1",
    name: "Relay",
    protocol: "openai",
    templateKind: "relay"
  });
  controller.updateDraft({ apiKey: "sk-anything" });
  await controller.fetchDraftModels();

  assert.equal(store.modelPlans.draftFeedback?.kind, "fetchModelsFailed");
  assert.deepEqual(store.modelPlans.draftDiscoveredModels, []);
});

test("WorkspaceModelPlansController reports an empty successful model fetch", async () => {
  const { controller, store } = createController({
    detectModelPlan: async () => ({
      detection: passedCoreDetection(),
      discoveredModels: []
    })
  });

  controller.beginDraft({
    baseUrl: "https://api.example.com/v1",
    name: "Example",
    protocol: "openai",
    templateKind: "custom"
  });
  controller.updateDraft({ apiKey: "sk-test" });
  await controller.fetchDraftModels();

  assert.equal(store.modelPlans.draftFeedback?.kind, "fetchModelsEmpty");
  assert.deepEqual(store.modelPlans.draftDiscoveredModels, []);
  assert.equal(store.modelPlans.fetchingDraftModels, false);
});

test("WorkspaceModelPlansController clears the discovery catalog when connection fields change", async () => {
  const { controller, store } = createController({
    detectModelPlan: async () => ({
      detection: passedCoreDetection(),
      discoveredModels: [
        { id: "model-a", name: "Model A" },
        { id: "model-b", name: "Model B" }
      ]
    })
  });

  controller.beginDraft({
    baseUrl: "https://api.example.com/v1",
    name: "Example",
    protocol: "openai",
    templateKind: "custom"
  });
  controller.updateDraft({ apiKey: "sk-test" });
  await controller.fetchDraftModels();
  assert.equal(store.modelPlans.draftDiscoveredModels.length, 2);

  // Model selection changes keep the catalog usable.
  controller.updateDraft({ models: [{ id: "model-a", name: "Model A" }] });
  assert.equal(store.modelPlans.draftDiscoveredModels.length, 2);

  // Connection identity changes invalidate previously discovered models.
  controller.updateDraft({ baseUrl: "https://api.other.com/v1" });
  assert.deepEqual(store.modelPlans.draftDiscoveredModels, []);
});

test("WorkspaceModelPlansController repairs the default after explicit model changes", () => {
  const { controller, store } = createController({});

  controller.beginDraft({
    name: "Custom",
    protocol: "openai",
    templateKind: "custom"
  });
  controller.updateDraft({
    models: [
      { id: "first", name: "First" },
      { id: "second", name: "Second" }
    ]
  });
  assert.equal(store.modelPlans.draft?.defaultModel, "first");

  controller.updateDraft({ defaultModel: "second" });
  assert.equal(store.modelPlans.draft?.defaultModel, "second");

  controller.updateDraft({ models: [{ id: "first", name: "First" }] });
  assert.equal(store.modelPlans.draft?.defaultModel, "first");

  controller.updateDraft({ models: [] });
  assert.equal(store.modelPlans.draft?.defaultModel, "");
});

test("WorkspaceModelPlansController preserves edited plan models and repairs a missing default", async () => {
  const models = [
    { id: "first", name: "First", tier: "standard" as const },
    { id: "second", name: "Second", tier: "flagship" as const }
  ];
  const { controller, store } = createController({
    listModelPlans: async () => [
      { ...createPlan("plan-1", "openai"), defaultModel: null, models }
    ]
  });

  await controller.refreshPlans();
  controller.beginEditPlan("plan-1");

  assert.deepEqual(store.modelPlans.draft?.models, models);
  assert.equal(store.modelPlans.draft?.defaultModel, "first");
});

test("WorkspaceModelPlansController detects a saved plan through its plan id", async () => {
  const detectRequests: Array<{ planId?: string | null }> = [];
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
        models: input.models ?? [],
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
  // The editor resolves the discovered model into an explicit slot selection.
  controller.updateDraft({
    models: [{ id: "gpt-native", name: "GPT Native", tier: "flagship" }]
  });
  await controller.saveDraft();

  assert.deepEqual(creates, [
    {
      baseUrl: "",
      defaultModel: "gpt-native",
      enabled: true,
      models: [
        {
          id: "gpt-native",
          name: "GPT Native"
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
      // Match the real desktop settings client: daemon 409s are wrapped as
      // DesktopWorkspaceSettingsDaemonError, not TuttidProtocolError.
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

test("WorkspaceModelPlansController still recognizes TuttidProtocolError referenced deletes", async () => {
  const { controller, store } = createController({
    listModelPlans: async () => [createPlan("plan-1", "openai")],
    deleteModelPlan: async () => {
      throw new TuttidProtocolError({
        code: "model_plan_referenced",
        statusCode: 409
      });
    },
    listModelPlanReferences: async () => [
      { id: "local:codex", kind: "agent_target", name: "Codex" }
    ]
  });

  await controller.refreshPlans();
  await controller.confirmDeletePlan("plan-1");

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
        workspaceId: "workspace-1",
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

function createController(overrides: Partial<ModelPlansClient>): {
  controller: WorkspaceModelPlansController;
  notifications: string[];
  store: ReturnType<typeof createWorkspaceSettingsStore>;
} {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  const notifications: string[] = [];
  const controller = new WorkspaceModelPlansController({
    client: createModelPlansClient(overrides),
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
