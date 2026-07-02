import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTarget } from "@tutti-os/client-tuttid-ts";
import { mapAgentTargetsToAgentGuiProviderTargets } from "./workspaceAgentGuiProviderTargets.ts";

test("maps daemon Agent Targets into AgentGUI provider targets in sort order", () => {
  const targets = mapAgentTargetsToAgentGuiProviderTargets([
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
    }),
    createAgentTarget({
      enabled: false,
      id: "disabled-codex",
      name: "Disabled Codex",
      provider: "codex",
      sortOrder: 30
    })
  ]);

  assert.deepEqual(
    targets.map((target) => ({
      disabled: target.disabled,
      kind: target.ref.kind,
      provider: target.provider,
      targetId: target.targetId
    })),
    [
      {
        disabled: false,
        kind: "local_cli",
        provider: "codex",
        targetId: "local:codex"
      },
      {
        disabled: false,
        kind: "local_cli",
        provider: "claude-code",
        targetId: "local:claude-code"
      },
      {
        disabled: true,
        kind: "local_cli",
        provider: "codex",
        targetId: "disabled-codex"
      }
    ]
  );
});

function createAgentTarget(
  input: Pick<AgentTarget, "id" | "name" | "provider" | "sortOrder"> &
    Partial<AgentTarget>
): AgentTarget {
  return {
    createdAtUnixMs: 1,
    enabled: true,
    iconKey: null,
    launchRef: {
      provider: input.provider,
      type: "local_cli"
    },
    source: "system",
    updatedAtUnixMs: 1,
    ...input
  };
}
