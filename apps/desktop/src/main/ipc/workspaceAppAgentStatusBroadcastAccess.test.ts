import assert from "node:assert/strict";
import test from "node:test";
import { canBroadcastWorkspaceAppAgentStatus } from "./workspaceAppAgentStatusBroadcastAccess.ts";

test("Workspace mode preserves the legacy Agent status broadcaster", () => {
  assert.equal(
    canBroadcastWorkspaceAppAgentStatus({
      fusionActive: false,
      rendererAccess: null
    }),
    true
  );
});

test("Fusion mode accepts only the registered Dock broadcaster", () => {
  assert.equal(
    canBroadcastWorkspaceAppAgentStatus({
      fusionActive: true,
      rendererAccess: { kind: "dock", workspaceId: "workspace-a" }
    }),
    true
  );
  assert.equal(
    canBroadcastWorkspaceAppAgentStatus({
      fusionActive: true,
      rendererAccess: {
        kind: "window",
        windowInstanceId: "window-a",
        workspaceId: "workspace-a"
      }
    }),
    false
  );
  assert.equal(
    canBroadcastWorkspaceAppAgentStatus({
      fusionActive: true,
      rendererAccess: null
    }),
    false
  );
});
