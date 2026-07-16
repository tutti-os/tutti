import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopAgentDirectorySnapshot } from "@shared/contracts/agentDirectory.ts";
import type { DesktopWindowIntent } from "@shared/contracts/windowIntent.ts";
import {
  resolveStandaloneAgentLaunchConfiguration,
  resolveStandaloneAgentLaunchProvider
} from "./standaloneAgentLaunchProvider.ts";

test("standalone Agent startup falls back to the configured default provider", () => {
  assert.equal(
    resolveStandaloneAgentLaunchProvider({
      defaultProvider: "claude-code",
      intent: createAgentIntent()
    }),
    "claude-code"
  );
});

test("standalone Agent launch keeps an explicit provider", () => {
  assert.equal(
    resolveStandaloneAgentLaunchProvider({
      defaultProvider: "codex",
      intent: createAgentIntent({ provider: " hermes " })
    }),
    "hermes"
  );
});

test("standalone Agent launch preserves task Model Plan and model overrides", () => {
  const intent = createAgentIntent({
    model: "gpt-5",
    modelPlanId: "plan-1"
  });
  assert.deepEqual(
    resolveStandaloneAgentLaunchConfiguration({
      defaultProvider: "codex",
      intent
    }),
    {
      agentSessionId: null,
      agentTargetId: null,
      autoSubmit: false,
      draftPrompt: null,
      model: "gpt-5",
      modelPlanId: "plan-1",
      provider: "codex",
      userProjectPath: null
    }
  );
});

test("standalone Agent launch resolves a missing provider from its target", () => {
  assert.equal(
    resolveStandaloneAgentLaunchProvider({
      defaultProvider: "codex",
      intent: createAgentIntent({
        agentDirectorySnapshot: createAgentDirectorySnapshot(),
        agentTargetID: "remote:hermes"
      })
    }),
    "hermes"
  );
});

function createAgentIntent(
  input: Partial<Extract<DesktopWindowIntent, { kind: "agent" }>> = {}
): DesktopWindowIntent {
  return {
    kind: "agent",
    workspaceID: "workspace-1",
    ...input
  };
}

function createAgentDirectorySnapshot(): DesktopAgentDirectorySnapshot {
  return {
    agents: [
      {
        agentTargetId: "remote:hermes",
        availability: { status: "ready" },
        iconUrl: "https://example.com/hermes.png",
        name: "Hermes",
        provider: "hermes"
      }
    ],
    agentTargets: [],
    capturedAtUnixMs: 1,
    error: null,
    status: "ready"
  };
}
