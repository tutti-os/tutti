import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDesktopWindowIntent,
  createAgentWindowIntent,
  createFusionDockWindowIntent,
  createFusionToolWindowIntent,
  createWorkspaceWindowIntent,
  encodeDesktopWindowIntent,
  resolveDesktopWindowIntent
} from "./windowIntent.ts";

test("encodeDesktopWindowIntent includes locale and theme bootstrap parameters", () => {
  const search = encodeDesktopWindowIntent(
    createWorkspaceWindowIntent("workspace-1"),
    {
      dockPlacement: "left",
      locale: "zh-CN",
      themeAppearance: "dark",
      themeSource: "dark"
    }
  );

  const params = new URLSearchParams(search);
  assert.equal(params.get("view"), "workspace");
  assert.equal(params.get("workspaceId"), "workspace-1");
  assert.equal(params.get("lang"), "zh-CN");
  assert.equal(params.get("dockPlacement"), "left");
  assert.equal(params.get("themeSource"), "dark");
  assert.equal(params.get("theme"), "dark");
});

test("applyDesktopWindowIntent preserves theme bootstrap parameters in development URLs", () => {
  const url = applyDesktopWindowIntent(
    "http://localhost:5173/",
    createWorkspaceWindowIntent("workspace-1"),
    {
      locale: "en",
      themeAppearance: "light",
      themeSource: "system"
    }
  );

  assert.equal(
    url,
    "http://localhost:5173/?lang=en&themeSource=system&theme=light&view=workspace&workspaceId=workspace-1"
  );
});

test("Agent window intent exposes only native identity and an opaque launch payload", () => {
  const launchPayload = {
    arbitrary: { nested: ["value", 7] },
    provider: "future-provider"
  };
  const search = encodeDesktopWindowIntent(
    createAgentWindowIntent({
      launchPayload,
      resourceID: " session-1 ",
      windowInstanceID: " window-1 ",
      workspaceID: " workspace-1 "
    })
  );

  const params = new URLSearchParams(search);
  assert.equal(params.get("view"), "agent");
  assert.equal(params.get("workspaceId"), "workspace-1");
  assert.equal(params.get("fusionResourceId"), "session-1");
  assert.equal(params.get("fusionWindowId"), "window-1");
  assert.equal(
    params.get("fusionLaunchPayload"),
    JSON.stringify(launchPayload)
  );
  assert.equal(params.has("provider"), false);
  assert.equal(params.has("agentSessionId"), false);
  assert.deepEqual(resolveDesktopWindowIntent(search), {
    kind: "agent",
    launchPayload,
    resourceID: "session-1",
    windowInstanceID: "window-1",
    workspaceID: "workspace-1"
  });
});

test("Agent window intent drops malformed opaque JSON without interpreting it", () => {
  assert.deepEqual(
    resolveDesktopWindowIntent(
      "?view=agent&workspaceId=workspace-1&fusionResourceId=session-1&fusionLaunchPayload=%7B"
    ),
    {
      kind: "agent",
      resourceID: "session-1",
      workspaceID: "workspace-1"
    }
  );
});

test("Fusion Dock intent round-trips without exposing Workspace chrome", () => {
  const search = encodeDesktopWindowIntent(
    createFusionDockWindowIntent("workspace-1")
  );

  assert.equal(new URLSearchParams(search).get("view"), "fusion-dock");
  assert.deepEqual(resolveDesktopWindowIntent(search), {
    kind: "fusion-dock",
    workspaceID: "workspace-1"
  });
});

test("Fusion tool intent keeps native window and resource identities separate", () => {
  const search = encodeDesktopWindowIntent(
    createFusionToolWindowIntent({
      fusionWindowKind: "terminal",
      launchPayload: { sessionId: "terminal-7" },
      resourceID: "terminal-7",
      windowInstanceID: "window-3",
      workspaceID: "workspace-1"
    })
  );

  assert.deepEqual(resolveDesktopWindowIntent(search), {
    fusionWindowKind: "terminal",
    kind: "fusion-tool",
    launchPayload: { sessionId: "terminal-7" },
    resourceID: "terminal-7",
    windowInstanceID: "window-3",
    workspaceID: "workspace-1"
  });
});

test("Fusion tool intent rejects unknown native window kinds", () => {
  assert.deepEqual(
    resolveDesktopWindowIntent(
      "?view=fusion-tool&workspaceId=workspace-1&fusionWindowId=window-1&fusionWindowKind=unknown"
    ),
    { kind: "workspace-missing" }
  );
});

test("readInitialDockPlacementFromLocation resolves dock placement from search params", async () => {
  const { readInitialDockPlacementFromLocation } =
    await import("../preferences/index.ts");

  assert.equal(
    readInitialDockPlacementFromLocation("?dockPlacement=left"),
    "left"
  );
  assert.equal(
    readInitialDockPlacementFromLocation("?dockPlacement=invalid"),
    "bottom"
  );
  assert.equal(readInitialDockPlacementFromLocation(""), "bottom");
});
