import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopHostOpenAgentWindowInput } from "@shared/contracts/ipc";
import {
  handleStandaloneAgentGuiLaunch,
  type StandaloneAgentGuiLaunchHandlerContext
} from "./standaloneAgentGuiLaunchHandler.ts";

function createContext(
  overrides: Partial<StandaloneAgentGuiLaunchHandlerContext> = {}
): StandaloneAgentGuiLaunchHandlerContext {
  return {
    activateAgentSession() {},
    headerProvider: "codex",
    async openAgentWindow() {},
    workspaceId: "workspace-1",
    ...overrides
  };
}

test("standalone Agent session launches activate locally and clear an omitted target", async () => {
  const activations: unknown[] = [];
  const opened: DesktopHostOpenAgentWindowInput[] = [];

  await handleStandaloneAgentGuiLaunch(
    {
      agentSessionId: " session-2 ",
      provider: "claude-code",
      workspaceId: "workspace-1"
    },
    createContext({
      activateAgentSession(input) {
        activations.push(input);
      },
      async openAgentWindow(input) {
        opened.push(input);
      }
    })
  );

  assert.deepEqual(activations, [
    {
      agentSessionId: "session-2",
      agentTargetId: null,
      provider: "claude-code"
    }
  ]);
  assert.deepEqual(opened, []);
});

test("standalone Agent draft launches open a new window with the complete bootstrap intent", async () => {
  const opened: DesktopHostOpenAgentWindowInput[] = [];

  await handleStandaloneAgentGuiLaunch(
    {
      agentSessionId: "stale-session",
      agentTargetId: " target-2 ",
      autoSubmit: true,
      draftPrompt: " Fix the app ",
      openInNewWindow: true,
      provider: "claude-code",
      userProjectPath: " /workspace/app ",
      workspaceId: "workspace-1"
    },
    createContext({
      agentDirectorySnapshot: {
        agents: [],
        agentTargets: [],
        capturedAtUnixMs: 1,
        error: null,
        status: "ready"
      },
      async openAgentWindow(input) {
        opened.push(input);
      },
      providerStatusSnapshot: {
        capturedAt: "2026-07-13T00:00:00.000Z",
        defaultProvider: "codex",
        error: null,
        isLoading: false,
        pendingActions: [],
        statuses: []
      }
    })
  );

  assert.deepEqual(opened, [
    {
      agentSessionId: null,
      agentTargetId: "target-2",
      autoSubmit: true,
      draftPrompt: "Fix the app",
      providerStatusSnapshot: {
        capturedAt: "2026-07-13T00:00:00.000Z",
        defaultProvider: "codex",
        error: null,
        isLoading: false,
        pendingActions: [],
        statuses: []
      },
      agentDirectorySnapshot: {
        agents: [],
        agentTargets: [],
        capturedAtUnixMs: 1,
        error: null,
        status: "ready"
      },
      minimizeSourceWindow: false,
      provider: "claude-code",
      userProjectPath: "/workspace/app",
      workspaceId: "workspace-1"
    }
  ]);
});

test("standalone Agent provider launches do not inherit the current window target", async () => {
  const opened: DesktopHostOpenAgentWindowInput[] = [];

  await handleStandaloneAgentGuiLaunch(
    {
      provider: "claude-code",
      workspaceId: "workspace-1"
    },
    createContext({
      async openAgentWindow(input) {
        opened.push(input);
      }
    })
  );

  assert.equal(opened.length, 1);
  assert.equal("agentTargetId" in opened[0]!, false);
  assert.equal(opened[0]?.provider, "claude-code");
  assert.equal(opened[0]?.minimizeSourceWindow, false);
});

test("standalone Agent explicit session windows preserve the requested target", async () => {
  const opened: DesktopHostOpenAgentWindowInput[] = [];

  await handleStandaloneAgentGuiLaunch(
    {
      agentSessionId: "session-3",
      agentTargetId: "target-3",
      openInNewWindow: true,
      provider: "codex",
      workspaceId: "workspace-1"
    },
    createContext({
      async openAgentWindow(input) {
        opened.push(input);
      }
    })
  );

  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.agentSessionId, "session-3");
  assert.equal(opened[0]?.agentTargetId, "target-3");
});
