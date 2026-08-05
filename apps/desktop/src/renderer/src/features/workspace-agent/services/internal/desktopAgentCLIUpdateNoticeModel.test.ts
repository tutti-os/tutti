import assert from "node:assert/strict";
import test from "node:test";
import type { AgentGUIAgent } from "@tutti-os/agent-gui";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import {
  hasDesktopAgentCLIUpdateConverged,
  projectDesktopAgentCLIUpdateItems,
  projectDesktopAgentCLIUpdateNoticesForTarget
} from "./desktopAgentCLIUpdateNoticeModel.ts";

test("projects update notices only onto the exact current Agent target", () => {
  const notices = [
    {
      agentTargetId: "local:codex",
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      phase: "available" as const
    },
    {
      agentTargetId: "local:tutti-agent",
      currentVersion: "0.0.10",
      latestVersion: "0.0.11",
      phase: "available" as const
    }
  ];

  assert.deepEqual(
    projectDesktopAgentCLIUpdateNoticesForTarget(notices, "local:codex"),
    [notices[0]]
  );
  assert.deepEqual(
    projectDesktopAgentCLIUpdateNoticesForTarget(notices, "local:tutti-agent"),
    [notices[1]]
  );
  assert.deepEqual(
    projectDesktopAgentCLIUpdateNoticesForTarget(notices, "extension:codex"),
    []
  );
  assert.deepEqual(
    projectDesktopAgentCLIUpdateNoticesForTarget(notices, null),
    []
  );
});

test("projects an update onto the exact managed Agent target", () => {
  const items = projectDesktopAgentCLIUpdateItems(
    [createStatus("codex")],
    [
      createAgent({
        agentTargetId: "workspace-agent-codex",
        name: "Workspace Codex"
      }),
      createAgent({
        agentTargetId: "extension-codex",
        name: "Extension Codex",
        setupKind: "target_runtime"
      }),
      createAgent({
        agentTargetId: "local:codex",
        iconUrl: "builtin-icon.svg",
        name: "Codex Built-in"
      })
    ]
  );

  assert.deepEqual(items, [
    {
      agentTargetId: "local:codex",
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      provider: "codex"
    }
  ]);
});

test("fails closed when the exact managed target metadata does not match", () => {
  assert.deepEqual(
    projectDesktopAgentCLIUpdateItems(
      [createStatus("codex")],
      [
        createAgent({
          agentTargetId: "local:codex",
          name: "Wrong Provider",
          provider: "claude-code"
        })
      ]
    ),
    []
  );
});

test("does not create persistent Home chrome without an actionable update", () => {
  for (const status of [
    createStatus("codex", { updateAvailable: false }),
    createStatus("tutti-agent", { actions: [] }),
    createStatus("codex", { latestVersion: null })
  ]) {
    assert.deepEqual(
      projectDesktopAgentCLIUpdateItems(
        [status],
        [
          createAgent({
            agentTargetId: `local:${status.provider}`,
            name: "Built-in Agent",
            provider: status.provider
          })
        ]
      ),
      []
    );
  }
});

test("confirms completion only after the refreshed CLI version converges", () => {
  const item = projectDesktopAgentCLIUpdateItems(
    [createStatus("codex")],
    [createAgent({ agentTargetId: "local:codex", name: "Codex" })]
  )[0]!;

  assert.equal(
    hasDesktopAgentCLIUpdateConverged(item, createStatus("codex").update),
    false
  );
  assert.equal(
    hasDesktopAgentCLIUpdateConverged(
      item,
      createStatus("codex", { updateAvailable: false }).update
    ),
    false
  );
  assert.equal(
    hasDesktopAgentCLIUpdateConverged(item, {
      ...createStatus("codex").update,
      currentVersion: "1.3.0",
      updateAvailable: false
    }),
    true
  );
  assert.equal(
    hasDesktopAgentCLIUpdateConverged(item, {
      ...createStatus("codex").update,
      currentVersion: "1.3.0",
      latestVersion: "1.4.0",
      updateAvailable: true
    }),
    false
  );
});

function createStatus(
  provider: WorkspaceAgentProvider,
  overrides: {
    actions?: AgentProviderStatus["actions"];
    latestVersion?: string | null;
    updateAvailable?: boolean | null;
  } = {}
): AgentProviderStatus {
  return {
    provider,
    availability: { status: "ready", reasonCode: null },
    cli: {
      detected: true,
      installed: true,
      path: "/usr/local/bin/agent",
      version: "1.2.3",
      reasonCode: null
    },
    adapter: { available: true, reasonCode: null },
    auth: { status: "authenticated", accountLabel: null, reasonCode: null },
    update: {
      capability: "supported",
      source: "npm",
      currentVersion: "1.2.3",
      latestVersion:
        "latestVersion" in overrides ? overrides.latestVersion : "1.3.0",
      updateAvailable:
        "updateAvailable" in overrides ? overrides.updateAvailable : true,
      unsupportedReason: null,
      lastCheckedAt: "2026-08-04T00:00:00Z",
      reasonCode: null
    },
    actions: overrides.actions ?? [{ id: "update", kind: "daemon_action" }]
  } as unknown as AgentProviderStatus;
}

function createAgent(
  overrides: Partial<AgentGUIAgent> &
    Pick<AgentGUIAgent, "agentTargetId" | "name">
): AgentGUIAgent {
  return {
    availability: { status: "ready" },
    iconUrl: overrides.iconUrl ?? "extension-icon.svg",
    ownership: "self",
    provider: "codex",
    ...overrides
  };
}
