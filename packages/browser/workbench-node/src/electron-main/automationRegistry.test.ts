import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeAutomationRegistry } from "./automationRegistry.ts";
import type { BrowserGuestDebugger, BrowserGuestWebContents } from "./types.ts";

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

function guardedContents(events: string[]): BrowserGuestWebContents {
  let attached = false;
  let currentUrl = "about:blank";
  let messageListener:
    | ((event: unknown, method: string, params: unknown) => void)
    | null = null;
  const debuggerClient: BrowserGuestDebugger = {
    attach() {
      attached = true;
    },
    detach() {
      attached = false;
    },
    isAttached: () => attached,
    off(_event, listener) {
      if (messageListener === listener) messageListener = null;
      return this;
    },
    on(_event, listener) {
      messageListener = listener;
      return this;
    },
    async sendCommand(method) {
      events.push(method);
      return {};
    }
  };
  return {
    ...fakeContents("Page", "about:blank"),
    debugger: debuggerClient,
    getURL: () => currentUrl,
    session: {
      off() {
        return this;
      },
      on() {
        return this;
      },
      async resolveHost() {
        events.push("session.resolveHost");
        return { endpoints: [{ address: "93.184.216.34" }] };
      }
    },
    async loadURL(url) {
      events.push(`loadURL:${url}`);
      messageListener?.(null, "Fetch.requestPaused", {
        request: { url },
        requestId: "navigation"
      });
      while (!events.includes("Fetch.continueRequest")) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      currentUrl = url;
    }
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

test("new page authorization runs before requesting a renderer target", async () => {
  let requested = false;
  const registry = createBrowserNodeAutomationRegistry({
    authorize: async () => ({
      allowed: false,
      code: "blocked_by_policy",
      message: "private target"
    }),
    requestTarget: async () => {
      requested = true;
      return "agent:tab:1";
    },
    closeTarget: async () => undefined
  });

  await assert.rejects(
    registry.call({
      agentSessionId: "agent-a",
      args: { url: "http://169.254.169.254" },
      tool: "new_page",
      workspaceId: "ws-1"
    }),
    /blocked_by_policy/u
  );
  assert.equal(requested, false);
});

test("new page creates about:blank and enables the request guard before navigation", async () => {
  const events: string[] = [];
  const contents = guardedContents(events);
  let registry: ReturnType<typeof createBrowserNodeAutomationRegistry>;
  registry = createBrowserNodeAutomationRegistry({
    authorize: async () => ({ allowed: true }),
    authorizeRequest: async (input) => {
      assert.ok(input.resolveHost);
      assert.deepEqual(await input.resolveHost("public.example"), [
        "93.184.216.34"
      ]);
      return { allowed: true };
    },
    closeTarget: async () => undefined,
    requestTarget: async (input) => {
      assert.equal(input.url, "about:blank");
      registry.register("agent:tab:1", contents, {
        agentSessionId: "agent-a",
        selected: true,
        surfaceId: "agent",
        surfaceRole: "agent",
        tabId: "tab-1",
        workspaceId: "ws-1"
      });
      return "agent:tab:1";
    }
  });

  await registry.call({
    agentSessionId: "agent-a",
    args: { url: "https://public.example/start" },
    tool: "new_page",
    workspaceId: "ws-1"
  });

  assert.ok(events.indexOf("Fetch.enable") >= 0);
  assert.ok(
    events.indexOf("Fetch.enable") <
      events.indexOf("loadURL:https://public.example/start")
  );
});

test("automation target ids are isolated by workspace", () => {
  const registry = createBrowserNodeAutomationRegistry();
  for (const workspaceId of ["ws-1", "ws-2"]) {
    registry.register(
      "browser:tab:1",
      fakeContents(workspaceId, `https://${workspaceId}.test`),
      {
        selected: true,
        surfaceId: "browser",
        surfaceRole: "user",
        tabId: "tab-1",
        workspaceId
      }
    );
  }

  assert.equal(registry.list({ workspaceId: "ws-1" })[0]?.title, "ws-1");
  assert.equal(registry.list({ workspaceId: "ws-2" })[0]?.title, "ws-2");
});

test("releasing an Agent closes only its retained Browser pages", async () => {
  const closed: string[] = [];
  const registry = createBrowserNodeAutomationRegistry({
    closeTarget: async (target) => {
      closed.push(target.nodeId);
    }
  });
  registry.register("user:tab:1", fakeContents("User", "https://user.test"), {
    selected: true,
    surfaceId: "user",
    surfaceRole: "user",
    tabId: "tab-1",
    workspaceId: "ws-1"
  });
  registry.register(
    "agent-a:tab:1",
    fakeContents("Agent A", "https://agent.test"),
    {
      agentSessionId: "agent-a",
      selected: true,
      surfaceId: "agent-a",
      surfaceRole: "agent",
      tabId: "tab-1",
      workspaceId: "ws-1"
    }
  );

  await registry.releaseAgent("agent-a");
  assert.deepEqual(closed, ["agent-a:tab:1"]);
});

test("releasing an Agent waits for in-flight target work before disabling its guard", async () => {
  const events: string[] = [];
  let finishSelection!: () => void;
  const selectionBlocked = new Promise<void>((resolve) => {
    finishSelection = resolve;
  });
  const registry = createBrowserNodeAutomationRegistry({
    authorizeRequest: async () => ({ allowed: true }),
    selectTarget: async () => {
      events.push("select:start");
      await selectionBlocked;
      events.push("select:end");
    }
  });
  registry.register("user:tab:1", guardedContents(events), {
    selected: true,
    surfaceId: "user",
    surfaceRole: "user",
    tabId: "tab-1",
    workspaceId: "ws-1"
  });

  const call = registry.call({
    agentSessionId: "agent-a",
    args: { pageId: "user:tab:1" },
    tool: "select_page",
    workspaceId: "ws-1"
  });
  while (!events.includes("select:start")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const release = registry.releaseAgent("agent-a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes("Fetch.disable"), false);

  finishSelection();
  await Promise.all([call, release]);
  assert.ok(events.indexOf("select:end") < events.indexOf("Fetch.disable"));
  await assert.rejects(
    registry.call({
      agentSessionId: "agent-a",
      tool: "list_pages",
      workspaceId: "ws-1"
    }),
    /agent_session_released/u
  );
});

test("releasing an Agent closes a new page that finishes creating after release", async () => {
  const closed: string[] = [];
  let finishCreation!: () => void;
  let creationStarted!: () => void;
  const creationPending = new Promise<void>((resolve) => {
    finishCreation = resolve;
  });
  const started = new Promise<void>((resolve) => {
    creationStarted = resolve;
  });
  let registry!: ReturnType<typeof createBrowserNodeAutomationRegistry>;
  registry = createBrowserNodeAutomationRegistry({
    authorize: async () => ({ allowed: true }),
    closeTarget: async (target) => {
      closed.push(target.nodeId);
    },
    requestTarget: async () => {
      creationStarted();
      await creationPending;
      registry.register(
        "agent-a:tab:late",
        fakeContents("Late page", "about:blank"),
        {
          agentSessionId: "agent-a",
          selected: true,
          surfaceId: "agent-a",
          surfaceRole: "agent",
          tabId: "tab-late",
          workspaceId: "ws-1"
        }
      );
      return "agent-a:tab:late";
    }
  });

  const call = registry.call({
    agentSessionId: "agent-a",
    tool: "new_page",
    workspaceId: "ws-1"
  });
  await started;
  await registry.releaseAgent("agent-a");
  finishCreation();

  await assert.rejects(call, /agent_session_released/u);
  assert.deepEqual(closed, ["agent-a:tab:late"]);
});
