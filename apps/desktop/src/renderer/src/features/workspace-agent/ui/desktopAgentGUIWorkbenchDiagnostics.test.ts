import assert from "node:assert/strict";
import test from "node:test";
import { logAgentComposerDefaultsDiagnostic } from "./desktopAgentGUIWorkbenchDiagnostics.ts";

test("agent composer defaults final failure diagnostic contains metadata but no selected values", async () => {
  const diagnostics: Array<{
    details: Record<string, unknown>;
    event: string;
  }> = [];
  logAgentComposerDefaultsDiagnostic({
    agentTargetId: "local:opencode",
    error: Object.assign(new Error("daemon unavailable"), {
      name: "AgentComposerDefaultsPatchFailure",
      details: {
        agentTargetId: "local:opencode",
        attemptCount: 3,
        changedFields: ["model", "permissionModeId"],
        correlationId: "mutation-1",
        durationMs: 4_000,
        errorCode: "unavailable",
        errorMessage: "daemon unavailable"
      }
    }),
    provider: "opencode",
    runtimeApi: {
      logTerminalDiagnostic: async (payload) => {
        diagnostics.push(payload as (typeof diagnostics)[number]);
      }
    },
    workspaceId: "workspace-1"
  });
  await Promise.resolve();

  assert.deepEqual(diagnostics, [
    {
      details: {
        agentTargetId: "local:opencode",
        attemptCount: 3,
        changedFields: "model,permissionModeId",
        correlationId: "mutation-1",
        durationMs: 4_000,
        errorCode: "unavailable",
        errorMessage: "daemon unavailable",
        provider: "opencode"
      },
      event: "agent.gui.composer_defaults.remember_failed",
      level: "warn",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("full-access"), false);
});
