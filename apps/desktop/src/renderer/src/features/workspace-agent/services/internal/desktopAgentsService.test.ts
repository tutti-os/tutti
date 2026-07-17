import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTarget, WorkspaceAgent } from "@tutti-os/client-tuttid-ts";
import {
  DesktopAgentsService,
  mapAgentTargetsToPresentations,
  mapAgentTargetPresentationsToAgents,
  mapWorkspaceAgentsToAgents
} from "./desktopAgentsService.ts";

test("desktop agents service publishes explicit idle, loading, and ready lifecycle snapshots", async () => {
  const request = createDeferred<{ targets: AgentTarget[] }>();
  const service = new DesktopAgentsService({
    now: () => 1780272000123,
    tuttidClient: {
      listAgentTargets: () => request.promise,
      listWorkspaceAgents: async () => ({ agents: [] })
    },
    workspaceId: "workspace-1"
  });
  const snapshots: string[] = [];
  service.subscribe(() => {
    snapshots.push(service.getSnapshot().status);
  });

  assert.equal(service.getSnapshot().status, "idle");
  const loadPromise = service.load();
  assert.equal(service.getSnapshot().status, "loading");

  request.resolve({
    targets: [
      createAgentTarget({
        id: "local:codex",
        heroImageUrl: "data:image/jpeg;base64,hero",
        name: "Codex",
        provider: "codex",
        sortOrder: 10
      })
    ]
  });
  const snapshot = await loadPromise;

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.capturedAtUnixMs, 1780272000123);
  assert.deepEqual(snapshots, ["loading", "ready"]);
});

test("desktop agents service publishes failures, retains cached data, and owns retry scheduling", async () => {
  const retryCallbacks: Array<() => void> = [];
  let shouldFail = false;
  const target = createAgentTarget({
    id: "local:codex",
    name: "Codex",
    provider: "codex",
    sortOrder: 10
  });
  const service = new DesktopAgentsService({
    retryDelayMs: 25,
    setTimeout(callback) {
      retryCallbacks.push(callback);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    tuttidClient: {
      async listAgentTargets() {
        if (shouldFail) {
          throw new Error("directory unavailable");
        }
        return { targets: [target] };
      },
      listWorkspaceAgents: async () => ({ agents: [] })
    },
    workspaceId: "workspace-1"
  });

  const readySnapshot = await service.load();
  shouldFail = true;
  await assert.rejects(service.refresh(), /directory unavailable/);

  const errorSnapshot = service.getSnapshot();
  assert.equal(errorSnapshot.status, "error");
  assert.equal(errorSnapshot.error, "directory unavailable");
  assert.deepEqual(errorSnapshot.agents, readySnapshot.agents);
  assert.equal(retryCallbacks.length, 1);

  shouldFail = false;
  retryCallbacks[0]?.();
  await waitFor(() => service.getSnapshot().status === "ready");
  assert.equal(service.getSnapshot().error, null);
});

test("desktop agents service hydrates a detached-window bootstrap snapshot before refresh", () => {
  const service = new DesktopAgentsService({
    tuttidClient: {
      async listAgentTargets() {
        return { targets: [] };
      },
      listWorkspaceAgents: async () => ({ agents: [] })
    },
    workspaceId: "workspace-1"
  });
  const target = createAgentTarget({
    id: "local:codex",
    name: "Codex",
    provider: "codex",
    sortOrder: 10
  });
  const agentTargets = mapAgentTargetsToPresentations([target]);

  service.hydrate({
    agents: mapAgentTargetPresentationsToAgents(agentTargets),
    agentTargets,
    capturedAtUnixMs: 1780272000000,
    error: null,
    status: "ready"
  });

  assert.equal(service.getSnapshot().status, "ready");
  assert.equal(service.getSnapshot().agents[0]?.agentTargetId, "local:codex");
});

test("desktop agents service maps enabled daemon targets into the AgentGUI agents directory", () => {
  const presentations = mapAgentTargetsToPresentations(
    [
      createAgentTarget({
        enabled: false,
        id: "local:claude-code",
        name: "Claude Code",
        provider: "claude-code",
        sortOrder: 20
      }),
      createAgentTarget({
        id: "local:codex",
        heroImageUrl: "data:image/jpeg;base64,hero",
        iconKey: "codex-descriptor",
        name: "Codex",
        provider: "codex",
        sortOrder: 10
      })
    ],
    {
      resolveAgentTargetIconUrl: ({ iconKey, provider }) =>
        `tutti-asset://agent/${iconKey ?? provider}.png`
    }
  );

  assert.deepEqual(
    presentations.map((target) => ({
      agentTargetId: target.agentTargetId,
      iconUrl: target.iconUrl,
      heroImageUrl: target.heroImageUrl,
      launchRefType: target.launchRefType,
      provider: target.provider
    })),
    [
      {
        agentTargetId: "local:codex",
        iconUrl: "tutti-asset://agent/codex-descriptor.png",
        heroImageUrl: "data:image/jpeg;base64,hero",
        launchRefType: "builtin_local",
        provider: "codex"
      },
      {
        agentTargetId: "local:claude-code",
        iconUrl: "tutti-asset://agent/claude-code.png",
        heroImageUrl: null,
        launchRefType: "builtin_local",
        provider: "claude-code"
      }
    ]
  );

  assert.deepEqual(mapAgentTargetPresentationsToAgents(presentations), [
    {
      agentTargetId: "local:codex",
      availability: { status: "ready" },
      iconUrl: "tutti-asset://agent/codex-descriptor.png",
      heroImageUrl: "data:image/jpeg;base64,hero",
      name: "Codex",
      provider: "codex"
    }
  ]);
});

test("desktop agents service resolves target iconKey before provider artwork", () => {
  const [presentation] = mapAgentTargetsToPresentations(
    [
      {
        ...createAgentTarget({
          id: "shared:alice",
          name: "Alice's Codex",
          provider: "codex",
          sortOrder: 10
        }),
        iconKey: "alice-custom"
      }
    ],
    {
      resolveAgentTargetIconUrl: ({ iconKey, provider }) =>
        `tutti-asset://agent/${iconKey ?? provider}.png`
    }
  );

  assert.equal(presentation?.iconUrl, "tutti-asset://agent/alice-custom.png");
});

test("desktop agents service projects provider gates to targets and AgentGUI agents", async () => {
  const service = new DesktopAgentsService({
    isAgentTargetProviderGated: (provider) => provider === "codex",
    tuttidClient: {
      listAgentTargets: async () => ({
        targets: [
          createAgentTarget({
            id: "local:codex",
            name: "Codex",
            provider: "codex",
            sortOrder: 10
          })
        ]
      }),
      listWorkspaceAgents: async () => ({ agents: [] })
    },
    workspaceId: "workspace-1"
  });

  const snapshot = await service.load();

  assert.equal(snapshot.agentTargets[0]?.enabled, false);
  assert.deepEqual(snapshot.agents, [
    {
      agentTargetId: "local:codex",
      availability: { status: "coming_soon" },
      iconUrl: "",
      name: "Codex",
      provider: "codex"
    }
  ]);
});

test("desktop agents service projects explicit workspace Agents as opaque AgentGUI identities", () => {
  const agents = mapWorkspaceAgentsToAgents(
    [
      createWorkspaceAgent({
        description: "Review changes",
        id: "workspace-agent:reviewer",
        name: "Reviewer"
      }),
      createWorkspaceAgent({
        description: "Implement changes",
        id: "workspace-agent:builder",
        name: "Builder"
      })
    ],
    {
      resolveAgentTargetIconUrl: ({ iconKey, provider }) =>
        `tutti-asset://agent/${iconKey ?? provider}.png`
    }
  );

  assert.deepEqual(
    agents.map((agent) => ({
      agentTargetId: agent.agentTargetId,
      description: agent.description,
      name: agent.name,
      provider: agent.provider
    })),
    [
      {
        agentTargetId: "workspace-agent:reviewer",
        description: "Review changes",
        name: "Reviewer",
        provider: "codex"
      },
      {
        agentTargetId: "workspace-agent:builder",
        description: "Implement changes",
        name: "Builder",
        provider: "codex"
      }
    ]
  );
});

test("desktop agents service merges built-in Harness targets with workspace Agents", async () => {
  const service = new DesktopAgentsService({
    tuttidClient: {
      listAgentTargets: async () => ({
        targets: [
          createAgentTarget({
            id: "local:claude-code",
            name: "Claude Code",
            provider: "claude-code",
            sortOrder: 20
          }),
          createAgentTarget({
            id: "local:codex",
            name: "Codex",
            provider: "codex",
            sortOrder: 10
          })
        ]
      }),
      listWorkspaceAgents: async () => ({
        agents: [
          createWorkspaceAgent({
            id: "workspace-agent:reviewer",
            name: "Reviewer"
          })
        ]
      })
    },
    workspaceId: "workspace-1"
  });

  const snapshot = await service.load();

  // Built-in targets keep their sortOrder-first placement; workspace Agents
  // are appended rather than replacing the built-in directory.
  assert.deepEqual(
    snapshot.agents.map((agent) => agent.agentTargetId),
    ["local:codex", "local:claude-code", "workspace-agent:reviewer"]
  );
  assert.deepEqual(
    snapshot.agentTargets.map((target) => target.agentTargetId),
    ["local:codex", "local:claude-code"]
  );
});

test("desktop agents service applies provider gates to built-ins in the merged directory", async () => {
  const service = new DesktopAgentsService({
    isAgentTargetProviderGated: (provider) => provider === "claude-code",
    tuttidClient: {
      listAgentTargets: async () => ({
        targets: [
          createAgentTarget({
            id: "local:claude-code",
            name: "Claude Code",
            provider: "claude-code",
            sortOrder: 20
          }),
          createAgentTarget({
            id: "local:codex",
            name: "Codex",
            provider: "codex",
            sortOrder: 10
          })
        ]
      }),
      listWorkspaceAgents: async () => ({
        agents: [
          createWorkspaceAgent({
            id: "workspace-agent:reviewer",
            name: "Reviewer"
          })
        ]
      })
    },
    workspaceId: "workspace-1"
  });

  const snapshot = await service.load();

  assert.deepEqual(
    snapshot.agents.map((agent) => ({
      agentTargetId: agent.agentTargetId,
      availability: agent.availability
    })),
    [
      { agentTargetId: "local:codex", availability: { status: "ready" } },
      {
        agentTargetId: "local:claude-code",
        availability: { status: "coming_soon" }
      },
      {
        agentTargetId: "workspace-agent:reviewer",
        availability: { status: "ready" }
      }
    ]
  );
});

test("desktop agents service dedupes merged directory entries by agent target id", async () => {
  const service = new DesktopAgentsService({
    tuttidClient: {
      listAgentTargets: async () => ({
        targets: [
          createAgentTarget({
            id: "local:codex",
            name: "Codex",
            provider: "codex",
            sortOrder: 10
          })
        ]
      }),
      listWorkspaceAgents: async () => ({
        agents: [
          createWorkspaceAgent({ id: "local:codex", name: "Shadowed" }),
          createWorkspaceAgent({
            id: "workspace-agent:reviewer",
            name: "Reviewer"
          })
        ]
      })
    },
    workspaceId: "workspace-1"
  });

  const snapshot = await service.load();

  assert.deepEqual(
    snapshot.agents.map((agent) => ({
      agentTargetId: agent.agentTargetId,
      name: agent.name
    })),
    [
      { agentTargetId: "local:codex", name: "Codex" },
      { agentTargetId: "workspace-agent:reviewer", name: "Reviewer" }
    ]
  );
});

function createAgentTarget(input: {
  enabled?: boolean;
  id: string;
  iconKey?: string | null;
  heroImageUrl?: string | null;
  name: string;
  provider: "claude-code" | "codex";
  sortOrder: number;
}): AgentTarget {
  return {
    createdAtUnixMs: 1780272000000,
    enabled: input.enabled ?? true,
    iconKey: input.iconKey ?? null,
    heroImageUrl: input.heroImageUrl ?? null,
    id: input.id,
    launchRef: {
      provider: input.provider,
      type: "builtin_local"
    },
    name: input.name,
    provider: input.provider,
    sortOrder: input.sortOrder,
    source: "system",
    updatedAtUnixMs: 1780272000000
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached");
}

function createWorkspaceAgent(
  input: Partial<WorkspaceAgent> & { id: string; name: string }
): WorkspaceAgent {
  const { id, name, ...overrides } = input;
  return {
    agentTargetId: id,
    createdAt: "2026-07-12T00:00:00Z",
    description: "",
    harness: {
      agentTargetId: "local:codex",
      available: true,
      enabled: true,
      iconKey: "codex",
      name: "Codex",
      provider: "codex"
    },
    id,
    instructions: "",
    name,
    revision: 1,
    skills: [],
    source: "user",
    tools: [],
    updatedAt: "2026-07-12T00:00:00Z",
    workspaceId: "workspace-1",
    ...overrides,
    capabilitiesExplicit: overrides.capabilitiesExplicit ?? false,
    callConditions: overrides.callConditions ?? [],
    modelFallbacks: overrides.modelFallbacks ?? []
  };
}
