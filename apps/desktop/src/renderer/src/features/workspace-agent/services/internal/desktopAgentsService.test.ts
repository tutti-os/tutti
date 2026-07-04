import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTarget } from "@tutti-os/client-tuttid-ts";
import {
  mapAgentTargetsToPresentations,
  mapAgentTargetPresentationsToProviderTargets
} from "./desktopAgentsService.ts";

test("desktop agents service maps agent targets into renderer presentations and AgentGUI provider targets", () => {
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

  assert.deepEqual(
    mapAgentTargetPresentationsToProviderTargets(presentations),
    [
      {
        agentTargetId: "local:codex",
        disabled: false,
        iconUrl: "tutti-asset://agent/codex.png",
        label: "Codex",
        provider: "codex",
        ref: {
          kind: "local_cli",
          provider: "codex",
          targetId: "local:codex"
        },
        targetId: "local:codex"
      },
      {
        agentTargetId: "local:claude-code",
        disabled: true,
        iconUrl: "tutti-asset://agent/claude-code.png",
        label: "Claude Code",
        provider: "claude-code",
        ref: {
          kind: "local_cli",
          provider: "claude-code",
          targetId: "local:claude-code"
        },
        targetId: "local:claude-code"
      }
    ]
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
