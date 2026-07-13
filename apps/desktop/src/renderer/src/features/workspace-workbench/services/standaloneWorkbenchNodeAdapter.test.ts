import assert from "node:assert/strict";
import test from "node:test";
import {
  canResolveStandaloneFusionNode,
  readStandaloneSettingsRequest,
  shouldCloseStandaloneAfterWorkspaceAppHandoff
} from "./standaloneWorkbenchNodeAdapter.ts";

test("Workspace App standalone launch waits for the matching App Center snapshot", () => {
  assert.equal(
    canResolveStandaloneFusionNode({
      appCenterLoadStatus: "loading",
      appCenterWorkspaceId: "workspace-1",
      kind: "workspace-app",
      workspaceId: "workspace-1"
    }),
    false
  );
  assert.equal(
    canResolveStandaloneFusionNode({
      appCenterLoadStatus: "ready",
      appCenterWorkspaceId: "workspace-2",
      kind: "workspace-app",
      workspaceId: "workspace-1"
    }),
    false
  );
  assert.equal(
    canResolveStandaloneFusionNode({
      appCenterLoadStatus: "ready",
      appCenterWorkspaceId: "workspace-1",
      kind: "workspace-app",
      workspaceId: "workspace-1"
    }),
    true
  );
});

test("non-App Fusion tools do not wait for App Center", () => {
  assert.equal(
    canResolveStandaloneFusionNode({
      appCenterLoadStatus: "loading",
      appCenterWorkspaceId: null,
      kind: "terminal",
      workspaceId: "workspace-1"
    }),
    true
  );
});

test("standalone settings request accepts only known anchors and sections", () => {
  assert.deepEqual(
    readStandaloneSettingsRequest({
      anchor: "computer-use",
      section: "general"
    }),
    { anchor: "computer-use", section: "general" }
  );
  assert.deepEqual(
    readStandaloneSettingsRequest({
      anchor: "unsafe-anchor",
      section: "unsafe-section"
    }),
    {}
  );
});

test("origin Workspace App window closes after a successful pending-restart handoff", () => {
  for (const launchPayload of [
    { appId: "docs" },
    {
      appId: "docs",
      intent: { kind: "open-route", route: "/files", state: { id: 1 } }
    }
  ]) {
    assert.equal(
      shouldCloseStandaloneAfterWorkspaceAppHandoff({
        handoffWindowOpened: Boolean(launchPayload.appId),
        kind: "workspace-app",
        resolvedNode: null
      }),
      true
    );
  }
  assert.equal(
    shouldCloseStandaloneAfterWorkspaceAppHandoff({
      handoffWindowOpened: false,
      kind: "workspace-app",
      resolvedNode: null
    }),
    false
  );
});
