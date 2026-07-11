import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDesktopWindowIntent,
  createAgentWindowIntent,
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

test("encodeDesktopWindowIntent includes agent window route parameters", () => {
  const search = encodeDesktopWindowIntent(
    createAgentWindowIntent({
      agentSessionID: " session-1 ",
      agentTargetID: " target-1 ",
      provider: " codex ",
      workspaceID: "workspace-1"
    })
  );

  const params = new URLSearchParams(search);
  assert.equal(params.get("view"), "agent");
  assert.equal(params.get("workspaceId"), "workspace-1");
  assert.equal(params.get("agentSessionId"), "session-1");
  assert.equal(params.get("agentTargetId"), "target-1");
  assert.equal(params.get("provider"), "codex");
  assert.deepEqual(resolveDesktopWindowIntent(search), {
    agentSessionID: "session-1",
    agentTargetID: "target-1",
    kind: "agent",
    provider: "codex",
    workspaceID: "workspace-1"
  });
});

test("encodeDesktopWindowIntent carries agent provider target bootstrap", () => {
  const search = encodeDesktopWindowIntent(
    createAgentWindowIntent({
      agentSessionID: "session-1",
      provider: "codex",
      providerStatusSnapshot: {
        capturedAt: "2026-07-07T00:00:00.000Z",
        defaultProvider: "codex",
        error: null,
        isLoading: false,
        pendingActions: [],
        statuses: []
      },
      agents: [
        {
          agentTargetId: "target-1",
          availability: { status: "ready" },
          iconUrl: "tutti-asset://agent/codex.png",
          name: "Codex",
          provider: "codex"
        }
      ],
      workspaceID: "workspace-1"
    })
  );

  const params = new URLSearchParams(search);
  assert.ok(params.get("agents"));
  assert.ok(params.get("agentProviderStatusSnapshot"));
  assert.deepEqual(resolveDesktopWindowIntent(search), {
    agentSessionID: "session-1",
    agentTargetID: null,
    kind: "agent",
    provider: "codex",
    providerStatusSnapshot: {
      capturedAt: "2026-07-07T00:00:00.000Z",
      defaultProvider: "codex",
      error: null,
      isLoading: false,
      pendingActions: [],
      statuses: []
    },
    agents: [
      {
        agentTargetId: "target-1",
        availability: { status: "ready" },
        iconUrl: "tutti-asset://agent/codex.png",
        name: "Codex",
        provider: "codex"
      }
    ],
    workspaceID: "workspace-1"
  });
});

test("encodeDesktopWindowIntent preserves an explicitly loaded empty agent directory", () => {
  const search = encodeDesktopWindowIntent(
    createAgentWindowIntent({
      agents: [],
      provider: "codex",
      workspaceID: "workspace-1"
    })
  );

  assert.equal(new URLSearchParams(search).get("agents"), "[]");
  assert.deepEqual(resolveDesktopWindowIntent(search), {
    agentSessionID: null,
    agentTargetID: null,
    agents: [],
    kind: "agent",
    provider: "codex",
    workspaceID: "workspace-1"
  });
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
