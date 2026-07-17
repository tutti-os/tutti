import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTarget } from "@tutti-os/client-tuttid-ts";
import type { WorkspaceAgentDefinition } from "../workspaceSettingsTypes.ts";
import {
  parseWorkspaceAgentList,
  WorkspaceAgentsController,
  workspaceAgentDraftToPutInput,
  type WorkspaceAgentsControllerDependencies
} from "./workspaceAgentsController.ts";
import { createWorkspaceSettingsStore } from "./workspaceSettingsStore.ts";

test("workspace agents controller loads explicit Agents and system runtimes", async () => {
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

test("workspace agents controller creates one Agent from the simplified draft", async () => {
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
          purpose: input.purpose
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
    modelPlanId: "plan-1",
    name: "Reviewer",
    purpose: "Review changes"
  });

  await controller.saveDraft();

  assert.deepEqual(requests, [
    {
      callConditions: ["Before release", "On architecture risk"],
      capabilitiesExplicit: false,
      defaultModel: "gpt-5",
      enabled: true,
      harnessAgentTargetId: "local:codex",
      instructions: "Review carefully",
      modelFallbacks: [],
      modelPlanId: "plan-1",
      name: "Reviewer",
      permissions: [],
      purpose: "Review changes",
      skills: [],
      tools: []
    }
  ]);
  assert.equal(store.agents.draft, null);
  assert.equal(store.agents.agents[0]?.name, "Reviewer");
  assert.equal(directoryRefreshes, 1);
});

test("saving an Agent with dormant explicit configuration returns it to neutral values", async () => {
  const store = createWorkspaceSettingsStore();
  store.workspaceID = "workspace-1";
  store.agents.agents = [
    createWorkspaceAgent({
      capabilitiesExplicit: true,
      modelFallbacks: [{ modelPlanId: "plan-fallback", model: "gpt-backup" }],
      permissions: ["workspace.write"],
      skills: ["react"],
      tools: ["terminal"]
    })
  ];
  const requests: unknown[] = [];
  const controller = new WorkspaceAgentsController({
    client: createClient({
      updateWorkspaceAgent: async (_workspaceID, _agentID, input) => {
        requests.push(input);
        return createWorkspaceAgent();
      }
    }),
    store
  });

  controller.beginEditAgent("workspace-agent:1");
  await controller.saveDraft();

  assert.equal(requests.length, 1);
  const request = requests[0] as {
    capabilitiesExplicit: boolean;
    modelFallbacks: unknown[];
    permissions: string[];
    skills: string[];
    tools: string[];
  };
  assert.equal(request.capabilitiesExplicit, false);
  assert.deepEqual(request.modelFallbacks, []);
  assert.deepEqual(request.permissions, []);
  assert.deepEqual(request.skills, []);
  assert.deepEqual(request.tools, []);
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

test("workspaceAgentDraftToPutInput always sends the dormant contract fields as neutral values", () => {
  assert.deepEqual(
    workspaceAgentDraftToPutInput({
      agentId: null,
      name: " Reviewer ",
      purpose: " Reviews changes ",
      harnessAgentTargetId: " local:codex ",
      modelPlanId: "",
      defaultModel: "",
      instructions: "",
      callConditions: "",
      enabled: true
    }),
    {
      callConditions: [],
      capabilitiesExplicit: false,
      defaultModel: null,
      enabled: true,
      harnessAgentTargetId: "local:codex",
      instructions: "",
      modelFallbacks: [],
      modelPlanId: null,
      name: "Reviewer",
      permissions: [],
      purpose: "Reviews changes",
      skills: [],
      tools: []
    }
  );
});

test("parseWorkspaceAgentList trims, removes blanks, and keeps stable uniqueness", () => {
  assert.deepEqual(parseWorkspaceAgentList(" alpha \n\n beta\nalpha "), [
    "alpha",
    "beta"
  ]);
});

function createClient(
  overrides: Partial<WorkspaceAgentsControllerDependencies["client"]> = {}
): WorkspaceAgentsControllerDependencies["client"] {
  return {
    createWorkspaceAgent: async () => createWorkspaceAgent(),
    deleteWorkspaceAgent: async () => undefined,
    listAgentTargets: async () => [],
    listWorkspaceAgents: async () => [],
    updateWorkspaceAgent: async () => createWorkspaceAgent(),
    ...overrides
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
    capabilitiesExplicit: false,
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
    permissions: [],
    purpose: "Review changes",
    revision: 1,
    skills: [],
    source: "user",
    tools: [],
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
