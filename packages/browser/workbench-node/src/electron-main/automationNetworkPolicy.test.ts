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

test("automation network policy permits every HTTP and HTTPS target", async () => {
  const authorize = createBrowserNodeAutomationNetworkAuthorizer();
  for (const url of [
    "https://example.com",
    "http://127.0.0.1:3000",
    "http://10.0.0.2",
    "http://169.254.169.254/latest/meta-data",
    "http://router.local",
    "https://198.18.0.178"
  ]) {
    assert.deepEqual(await authorize(authorizationInput(url)), {
      allowed: true
    });
  }
});

test("automation network policy retains URL and protocol validation", async () => {
  const authorize = createBrowserNodeAutomationNetworkAuthorizer();
  assert.deepEqual(
    await authorize(authorizationInput("https://example.com", "not a url")),
    {
      allowed: false,
      code: "invalid_url",
      message: "The browser URL is invalid"
    }
  );
  assert.deepEqual(
    await authorize(
      authorizationInput("https://example.com", "file:///etc/hosts")
    ),
    {
      allowed: false,
      code: "unsupported_protocol",
      message: "Browser automation only supports HTTP and HTTPS pages"
    }
  );
});
