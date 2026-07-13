import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTarget } from "@tutti-os/client-tuttid-ts";
import {
  mapAgentTargetsToPresentations,
  mapAgentTargetPresentationsToAgents
} from "./desktopAgentsService.ts";

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
      launchRefType: target.launchRefType,
      provider: target.provider
    })),
    [
      {
        agentTargetId: "local:codex",
        iconUrl: "tutti-asset://agent/codex-descriptor.png",
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
      iconUrl: "tutti-asset://agent/codex-descriptor.png",
      name: "Codex",
      provider: "codex"
    }
  ]);
});

function createAgentTarget(input: {
  enabled?: boolean;
  id: string;
  iconKey?: string | null;
  name: string;
  provider: "claude-code" | "codex";
  sortOrder: number;
}): AgentTarget {
  return {
    createdAtUnixMs: 1780272000000,
    enabled: input.enabled ?? true,
    iconKey: input.iconKey ?? null,
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
