import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTarget, WorkspaceAgent } from "@tutti-os/client-tuttid-ts";
import {
  normalizeAgentGUIAgents,
  projectAgentGUIAgentsToTargets
} from "@tutti-os/agent-gui/agents";
import {
  DesktopAgentsService,
  mapAgentTargetsToPresentations,
  mapAgentTargetPresentationsToAgents
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
    workspaceId: "workspace-1",
    tuttidClient: {
      async listWorkspaceAgents() {
        return { agents: [] };
      },
      async listAgentTargets() {
        if (shouldFail) {
          throw new Error("directory unavailable");
        }
        return { targets: [target] };
      }
    }
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
    workspaceId: "workspace-1",
    tuttidClient: {
      async listWorkspaceAgents() {
        return { agents: [] };
      },
      async listAgentTargets() {
        return { targets: [] };
      }
    }
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
  const presentations = mapAgentTargetsToPresentations([
    createAgentTarget({
      enabled: false,
      id: "local:claude-code",
      iconUrl: "tutti-asset://agent/claudecode.png",
      maskIconUrl: "tutti-asset://agent/claudecode-mask.svg",
      name: "Claude Code",
      provider: "claude-code",
      sortOrder: 20
    }),
    createAgentTarget({
      id: "local:codex",
      heroImageUrl: "data:image/jpeg;base64,hero",
      maskIconUrl: "data:image/svg+xml;base64,mask",
      iconKey: "codex-descriptor",
      iconUrl: "tutti-asset://agent/codex.png",
      name: "Codex",
      provider: "codex",
      sortOrder: 10
    })
  ]);

  assert.deepEqual(
    presentations.map((target) => ({
      agentTargetId: target.agentTargetId,
      iconUrl: target.iconUrl,
      maskIconUrl: target.maskIconUrl,
      heroImageUrl: target.heroImageUrl,
      launchRefType: target.launchRefType,
      provider: target.provider
    })),
    [
      {
        agentTargetId: "local:codex",
        iconUrl: "tutti-asset://agent/codex.png",
        maskIconUrl: "data:image/svg+xml;base64,mask",
        heroImageUrl: "data:image/jpeg;base64,hero",
        launchRefType: "builtin_local",
        provider: "codex"
      },
      {
        agentTargetId: "local:claude-code",
        iconUrl: "tutti-asset://agent/claudecode.png",
        maskIconUrl: "tutti-asset://agent/claudecode-mask.svg",
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
      iconUrl: "tutti-asset://agent/codex.png",
      maskIconUrl: "data:image/svg+xml;base64,mask",
      heroImageUrl: "data:image/jpeg;base64,hero",
      name: "Codex",
      ownership: "self",
      provider: "codex"
    }
  ]);
});

test("desktop agents service lists a custom Agent with its Harness target catalog icon", async () => {
  let listedWorkspaceId = "";
  const service = new DesktopAgentsService({
    resolveAgentTargetIconUrl: ({ iconKey, provider }) =>
      iconKey ? `catalog://${iconKey}` : `catalog://provider/${provider}`,
    tuttidClient: {
      async listAgentTargets() {
        return {
          targets: [
            createAgentTarget({
              iconKey: "codex-target",
              iconUrl: null,
              id: "local:codex",
              name: "Codex",
              provider: "codex",
              sortOrder: 10
            })
          ]
        };
      },
      async listWorkspaceAgents(workspaceId) {
        listedWorkspaceId = workspaceId;
        return {
          agents: [
            createWorkspaceAgent({
              harness: {
                agentTargetId: "local:codex",
                available: true,
                enabled: true,
                iconKey: null,
                name: "Codex",
                provider: "codex"
              },
              modelPlanId: "plan-1"
            })
          ]
        };
      }
    },
    workspaceId: "workspace-1"
  });

  const snapshot = await service.load();
  const customAgent = snapshot.agents.find(
    (agent) => agent.agentTargetId === "workspace-agent:reviewer"
  );
  const normalizedAgents = normalizeAgentGUIAgents(snapshot.agents);
  const customTarget = projectAgentGUIAgentsToTargets(normalizedAgents).find(
    (target) => target.agentTargetId === "workspace-agent:reviewer"
  );

  assert.equal(listedWorkspaceId, "workspace-1");
  assert.equal(customAgent?.iconUrl, "catalog://codex-target");
  assert.equal(customAgent?.providerAccountUsageApplicable, false);
  assert.deepEqual(
    service.getAgentPresentation({
      agentTargetId: "workspace-agent:reviewer"
    }),
    {
      iconUrl: "catalog://codex-target",
      name: "Reviewer"
    }
  );
  assert.deepEqual(customTarget, {
    agentTargetId: "workspace-agent:reviewer",
    availability: { status: "ready" },
    description: "Reviews workspace changes",
    iconUrl: "catalog://codex-target",
    label: "Reviewer",
    ownership: "self",
    provider: "codex",
    providerAccountUsageApplicable: false,
    ref: {
      agentTargetId: "workspace-agent:reviewer",
      kind: "agent-directory",
      provider: "codex"
    },
    targetId: "workspace-agent:reviewer"
  });
});

test("desktop agents service preserves Extension primary and mask icons", () => {
  const presentations = mapAgentTargetsToPresentations([
    {
      createdAtUnixMs: 1780272000000,
      enabled: true,
      heroImageUrl: null,
      iconKey: "extension:gemini",
      iconUrl: "data:image/svg+xml;base64,colored",
      maskIconUrl: "data:image/svg+xml;base64,mask",
      id: "extension:gemini",
      launchRef: {
        extensionInstallationId: "gemini@1.0.3",
        type: "agent_extension"
      },
      name: "Gemini CLI",
      provider: "acp:gemini",
      sortOrder: 700,
      source: "system",
      updatedAtUnixMs: 1780272000000
    }
  ]);

  assert.deepEqual(presentations.map(selectIconPresentation), [
    {
      agentTargetId: "extension:gemini",
      iconUrl: "data:image/svg+xml;base64,colored",
      maskIconUrl: "data:image/svg+xml;base64,mask"
    }
  ]);
  assert.deepEqual(
    mapAgentTargetPresentationsToAgents(presentations, {
      earlyAccessEnabled: true
    }).map(selectIconPresentation),
    [
      {
        agentTargetId: "extension:gemini",
        iconUrl: "data:image/svg+xml;base64,colored",
        maskIconUrl: "data:image/svg+xml;base64,mask"
      }
    ]
  );
});

test("desktop agents service keeps stable extensions visible without Early Access", () => {
  const presentations = mapAgentTargetsToPresentations([
    {
      createdAtUnixMs: 1780272000000,
      enabled: true,
      heroImageUrl: null,
      iconKey: "extension:gemini",
      iconUrl: "data:image/svg+xml;base64,colored",
      maskIconUrl: "data:image/svg+xml;base64,mask",
      id: "extension:gemini",
      launchRef: {
        extensionInstallationId: "gemini@1.0.3",
        type: "agent_extension"
      },
      name: "Gemini CLI",
      provider: "acp:gemini",
      sortOrder: 700,
      source: "system",
      updatedAtUnixMs: 1780272000000
    },
    {
      createdAtUnixMs: 1780272000000,
      enabled: true,
      heroImageUrl: null,
      iconKey: "extension:hermes",
      iconUrl: "data:image/svg+xml;base64,hermes",
      maskIconUrl: null,
      id: "extension:hermes",
      launchRef: {
        extensionInstallationId: "hermes@1.0.0",
        type: "agent_extension"
      },
      name: "Hermes Agent",
      provider: "acp:hermes",
      sortOrder: 700,
      source: "system",
      updatedAtUnixMs: 1780272000000
    },
    {
      createdAtUnixMs: 1780272000000,
      enabled: true,
      heroImageUrl: null,
      iconKey: "extension:kimi-code",
      iconUrl: "data:image/svg+xml;base64,kimi-code",
      maskIconUrl: null,
      id: "extension:kimi-code",
      launchRef: {
        extensionInstallationId: "kimi-code@1.0.0",
        type: "agent_extension"
      },
      name: "Kimi Code",
      provider: "acp:kimi-code",
      sortOrder: 700,
      source: "system",
      updatedAtUnixMs: 1780272000000
    }
  ]);

  // Stable extensions stay launchable without the Early Access switch, while
  // integrations still under validation remain hidden.
  assert.deepEqual(
    mapAgentTargetPresentationsToAgents(presentations).map(
      (agent) => agent.agentTargetId
    ),
    ["extension:hermes", "extension:kimi-code"]
  );
  assert.deepEqual(
    mapAgentTargetPresentationsToAgents(presentations, {
      earlyAccessEnabled: false
    }).map((agent) => agent.agentTargetId),
    ["extension:hermes", "extension:kimi-code"]
  );
  // Early Access on: the remaining extension also becomes launchable.
  assert.deepEqual(
    mapAgentTargetPresentationsToAgents(presentations, {
      earlyAccessEnabled: true
    }).map((agent) => agent.agentTargetId),
    ["extension:gemini", "extension:hermes", "extension:kimi-code"]
  );
});

function selectIconPresentation(input: {
  agentTargetId: string;
  iconUrl: string;
  maskIconUrl?: string | null;
}) {
  return {
    agentTargetId: input.agentTargetId,
    iconUrl: input.iconUrl,
    maskIconUrl: input.maskIconUrl ?? null
  };
}

function createAgentTarget(input: {
  enabled?: boolean;
  id: string;
  iconKey?: string | null;
  iconUrl?: string | null;
  heroImageUrl?: string | null;
  maskIconUrl?: string | null;
  name: string;
  provider: "claude-code" | "codex";
  sortOrder: number;
}): AgentTarget {
  return {
    createdAtUnixMs: 1780272000000,
    enabled: input.enabled ?? true,
    iconKey: input.iconKey ?? null,
    iconUrl:
      "iconUrl" in input
        ? (input.iconUrl ?? null)
        : `tutti-asset://agent/${input.provider}.png`,
    heroImageUrl: input.heroImageUrl ?? null,
    maskIconUrl: input.maskIconUrl ?? null,
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

function createWorkspaceAgent(
  overrides: Partial<WorkspaceAgent> = {}
): WorkspaceAgent {
  return {
    agentTargetId: "workspace-agent:reviewer",
    capabilitiesExplicit: false,
    callConditions: ["Use for workspace reviews"],
    createdAt: "2026-07-23T00:00:00Z",
    defaultModel: null,
    description: "Reviews workspace changes",
    harness: {
      agentTargetId: "local:codex",
      available: true,
      enabled: true,
      iconKey: "codex",
      name: "Codex",
      provider: "codex"
    },
    id: "workspace-agent:reviewer",
    instructions: "Review carefully",
    modelFallbacks: [],
    modelPlanId: null,
    name: "Reviewer",
    revision: 1,
    skills: [],
    source: "user",
    tools: [],
    updatedAt: "2026-07-23T00:00:00Z",
    workspaceId: "workspace-1",
    ...overrides
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
