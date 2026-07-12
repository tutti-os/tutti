import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTarget } from "@tutti-os/client-tuttid-ts";
import {
  DesktopAgentsService,
  mapAgentTargetsToPresentations,
  mapAgentTargetPresentationsToAgents
} from "./desktopAgentsService.ts";

test("desktop agents service maps agent targets into renderer presentations and AgentGUI agents", () => {
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
        name: "Codex",
        provider: "codex",
        sortOrder: 10
      })
    ],
    {
      resolveAgentIconUrl: (provider) => `tutti-asset://agent/${provider}.png`
    }
  );

  assert.deepEqual(
    presentations.map((target) => ({
      agentTargetId: target.agentTargetId,
      iconUrl: target.iconUrl,
      launchRefType: target.launchRefType,
      provider: target.provider
    })),
    [
      {
        agentTargetId: "local:codex",
        iconUrl: "tutti-asset://agent/codex.png",
        launchRefType: "local_cli",
        provider: "codex"
      },
      {
        agentTargetId: "local:claude-code",
        iconUrl: "tutti-asset://agent/claude-code.png",
        launchRefType: "local_cli",
        provider: "claude-code"
      }
    ]
  );

  assert.deepEqual(mapAgentTargetPresentationsToAgents(presentations), [
    {
      agentTargetId: "local:codex",
      availability: { status: "ready" },
      iconUrl: "tutti-asset://agent/codex.png",
      name: "Codex",
      provider: "codex"
    }
  ]);
});

test("desktop agents service does not emit when fetched snapshot is unchanged", async () => {
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
      })
    }
  });
  const emitCount = { value: 0 };
  service.subscribe(() => {
    emitCount.value += 1;
  });

  await service.load();
  await service.load();
  await service.load();

  assert.equal(emitCount.value, 1);
});

test("desktop agents service emits when fetched snapshot changes", async () => {
  let targets: AgentTarget[] = [
    createAgentTarget({
      id: "local:codex",
      name: "Codex",
      provider: "codex",
      sortOrder: 10
    })
  ];
  const service = new DesktopAgentsService({
    tuttidClient: {
      listAgentTargets: async () => ({ targets })
    }
  });
  const emitCount = { value: 0 };
  service.subscribe(() => {
    emitCount.value += 1;
  });

  await service.load();
  targets = [
    createAgentTarget({
      id: "local:claude-code",
      name: "Claude Code",
      provider: "claude-code",
      sortOrder: 20
    })
  ];
  await service.load();

  assert.equal(emitCount.value, 2);
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
    { resolveAgentIconUrl: (key) => `tutti-asset://agent/${key}.png` }
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
      })
    }
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

test("desktop agents service discards results from stale requests", async () => {
  const requests: Array<(targets: AgentTarget[]) => void> = [];
  const service = new DesktopAgentsService({
    tuttidClient: {
      listAgentTargets: () =>
        new Promise((resolve) => {
          requests.push((targets) => resolve({ targets }));
        })
    }
  });
  const emittedProviders: string[][] = [];
  service.subscribe(() => {
    emittedProviders.push(
      service.getSnapshot().agentTargets.map((target) => target.provider)
    );
  });

  const staleLoad = service.load();
  const latestRefresh = service.refresh();
  requests[1]?.([
    createAgentTarget({
      id: "local:codex",
      name: "Codex",
      provider: "codex",
      sortOrder: 10
    })
  ]);
  await latestRefresh;
  requests[0]?.([
    createAgentTarget({
      id: "local:claude-code",
      name: "Claude Code",
      provider: "claude-code",
      sortOrder: 20
    })
  ]);
  await staleLoad;

  assert.deepEqual(emittedProviders, [["codex"]]);
  assert.deepEqual(
    service.getSnapshot().agentTargets.map((target) => target.provider),
    ["codex"]
  );
});

function createAgentTarget(input: {
  enabled?: boolean;
  id: string;
  name: string;
  provider: "claude-code" | "codex";
  sortOrder: number;
}): AgentTarget {
  return {
    createdAtUnixMs: 1780272000000,
    enabled: input.enabled ?? true,
    iconKey: null,
    id: input.id,
    launchRef: {
      provider: input.provider,
      type: "local_cli"
    },
    name: input.name,
    provider: input.provider,
    sortOrder: input.sortOrder,
    source: "system",
    updatedAtUnixMs: 1780272000000
  };
}
