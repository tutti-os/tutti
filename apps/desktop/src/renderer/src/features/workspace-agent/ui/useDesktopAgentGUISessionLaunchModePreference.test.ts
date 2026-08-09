import assert from "node:assert/strict";
import test from "node:test";
import { rememberDesktopAgentGUISessionLaunchModePreference } from "./useDesktopAgentGUISessionLaunchModePreference.ts";

test("records a launch mode preference for the exact workspace and project", async () => {
  const calls: unknown[][] = [];

  await rememberDesktopAgentGUISessionLaunchModePreference({
    desktopPreferencesService: {
      rememberAgentSessionLaunchMode: async (...args) => {
        calls.push(args);
      }
    },
    mode: "worktree",
    projectSectionKey: "project:/alpha",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(calls, [["workspace-1", "project:/alpha", "worktree"]]);
});

test("catches launch mode preference failures and records a diagnostic", async () => {
  const diagnostics: unknown[] = [];

  await rememberDesktopAgentGUISessionLaunchModePreference({
    desktopPreferencesService: {
      rememberAgentSessionLaunchMode: async () => {
        throw new Error("preferences unavailable");
      }
    },
    mode: "worktree",
    projectSectionKey: "project:/alpha",
    runtimeApi: {
      logTerminalDiagnostic: async (diagnostic: unknown) => {
        diagnostics.push(diagnostic);
      }
    } as never,
    workspaceId: "workspace-1"
  });

  assert.deepEqual(diagnostics, [
    {
      details: {
        error: "preferences unavailable",
        mode: "worktree",
        projectSectionKey: "project:/alpha"
      },
      event: "agent.gui.session_launch_mode_preference.remember_failed",
      level: "warn",
      workspaceId: "workspace-1"
    }
  ]);
});
