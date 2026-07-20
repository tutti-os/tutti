import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeAutomationRegistry } from "./automationRegistry.ts";
import type { BrowserGuestWebContents } from "./types.ts";

function fakeContents(title: string, url: string): BrowserGuestWebContents {
  return {
    canGoBack: () => false,
    canGoForward: () => false,
    getTitle: () => title,
    getURL: () => url,
    goBack() {},
    goForward() {},
    isDestroyed: () => false,
    isLoading: () => false,
    loadURL: async () => undefined,
    off() {
      return this;
    },
    on() {
      return this;
    },
    reload() {}
  };
}

test("automation targets expose user tabs and only the caller's agent tabs", () => {
  const registry = createBrowserNodeAutomationRegistry();
  registry.register("user:tab:1", fakeContents("User", "https://user.test"), {
    focused: true,
    selected: true,
    surfaceId: "user",
    surfaceRole: "user",
    tabId: "tab-1",
    workspaceId: "ws-1"
  });
  registry.register(
    "agent-a:tab:1",
    fakeContents("Agent A", "https://a.test"),
    {
      agentSessionId: "agent-a",
      selected: true,
      surfaceId: "agent-a",
      surfaceRole: "agent",
      tabId: "tab-1",
      workspaceId: "ws-1"
    }
  );
  registry.register(
    "agent-b:tab:1",
    fakeContents("Agent B", "https://b.test"),
    {
      agentSessionId: "agent-b",
      selected: true,
      surfaceId: "agent-b",
      surfaceRole: "agent",
      tabId: "tab-1",
      workspaceId: "ws-1"
    }
  );

  assert.deepEqual(
    registry
      .list({ agentSessionId: "agent-a", workspaceId: "ws-1" })
      .map((target) => target.nodeId),
    ["user:tab:1", "agent-a:tab:1"]
  );
});

test("automation leases reject a second agent on the same user tab", async () => {
  let timestamp = 10;
  const registry = createBrowserNodeAutomationRegistry({
    leaseTtlMs: 100,
    now: () => timestamp,
    selectTarget: async () => undefined
  });
  registry.register("user:tab:1", fakeContents("User", "https://user.test"), {
    focused: true,
    selected: true,
    surfaceId: "user",
    surfaceRole: "user",
    tabId: "tab-1",
    workspaceId: "ws-1"
  });

  await registry.call({
    agentSessionId: "agent-a",
    args: { pageId: "user:tab:1" },
    tool: "select_page",
    workspaceId: "ws-1"
  });
  await assert.rejects(
    registry.call({
      agentSessionId: "agent-b",
      args: { pageId: "user:tab:1" },
      tool: "select_page",
      workspaceId: "ws-1"
    }),
    /tab_in_use/u
  );

  timestamp = 111;
  await registry.call({
    agentSessionId: "agent-b",
    args: { pageId: "user:tab:1" },
    tool: "select_page",
    workspaceId: "ws-1"
  });
});

test("automation authorization runs before a target lease is acquired", async () => {
  const registry = createBrowserNodeAutomationRegistry({
    authorize: async () => ({
      allowed: false,
      code: "blocked_by_policy",
      message: "private target"
    }),
    selectTarget: async () => undefined
  });
  registry.register("user:tab:1", fakeContents("User", "http://10.0.0.1"), {
    selected: true,
    surfaceId: "user",
    surfaceRole: "user",
    tabId: "tab-1",
    workspaceId: "ws-1"
  });

  await assert.rejects(
    registry.call({
      agentSessionId: "agent-a",
      args: { pageId: "user:tab:1" },
      tool: "select_page",
      workspaceId: "ws-1"
    }),
    /blocked_by_policy/u
  );
});
