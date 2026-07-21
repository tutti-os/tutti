import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeAutomationNetworkAuthorizer } from "./automationNetworkPolicy.ts";
import type { BrowserNodeAutomationAuthorizationInput } from "./automationTypes.ts";

function authorizationInput(
  targetUrl: string,
  navigationUrl?: string
): BrowserNodeAutomationAuthorizationInput {
  return {
    agentSessionId: "agent-1",
    args: navigationUrl ? { url: navigationUrl } : {},
    target: {
      focused: true,
      nodeId: "browser:tab:1",
      selected: true,
      surfaceId: "browser",
      surfaceRole: "user",
      tabId: "tab-1",
      title: "Page",
      url: targetUrl,
      workspaceId: "workspace-1"
    },
    tool: navigationUrl ? "navigate_page" : "take_snapshot",
    workspaceId: "workspace-1"
  };
}

test("automation network policy permits public pages and only routed loopback", async () => {
  const authorize = createBrowserNodeAutomationNetworkAuthorizer({
    isLoopbackUrlRouted: async (url) => url === "http://127.0.0.1:3000/",
    resolveHost: async () => ["93.184.216.34"]
  });
  assert.deepEqual(await authorize(authorizationInput("https://example.com")), {
    allowed: true
  });
  assert.deepEqual(
    await authorize(authorizationInput("http://127.0.0.1:3000")),
    { allowed: true }
  );
  assert.equal(
    (await authorize(authorizationInput("http://127.0.0.1:4000"))).allowed,
    false
  );
});

test("automation request policy uses the target Chromium session resolver", async () => {
  let nodeResolverCalled = false;
  const authorize = createBrowserNodeAutomationNetworkAuthorizer({
    resolveHost: async () => {
      nodeResolverCalled = true;
      return ["10.0.0.2"];
    }
  });
  const input = authorizationInput("https://example.com");
  input.resolveHost = async () => ["93.184.216.34"];

  assert.deepEqual(await authorize(input), { allowed: true });
  assert.equal(nodeResolverCalled, false);
});

test("automation network policy blocks private current pages and navigation", async () => {
  const authorize = createBrowserNodeAutomationNetworkAuthorizer({
    resolveHost: async () => ["10.0.0.2"]
  });
  assert.equal(
    (await authorize(authorizationInput("https://internal.example"))).allowed,
    false
  );
  assert.equal(
    (
      await authorize(
        authorizationInput("https://example.com", "http://169.254.169.254")
      )
    ).allowed,
    false
  );
});
