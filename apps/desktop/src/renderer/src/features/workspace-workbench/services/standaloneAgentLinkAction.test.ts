import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopRendererDiagnosticPayload } from "@shared/contracts/ipc.ts";
import { runStandaloneAgentLinkAction } from "./standaloneAgentLinkAction.ts";

test("standalone Agent logs external link routing without query data", async () => {
  const diagnostics: DesktopRendererDiagnosticPayload[] = [];
  const openedUrls: string[] = [];
  const url = "https://example.com/private?token=secret";

  const handled = await runStandaloneAgentLinkAction(
    {
      source: "agent-markdown",
      type: "open-url",
      url
    },
    createDependencies({
      diagnostics,
      openExternalUrl: async (target) => {
        openedUrls.push(target);
      }
    })
  );

  assert.equal(handled, true);
  assert.deepEqual(openedUrls, [url]);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.event),
    [
      "agent.gui.standalone_link_action.received",
      "agent.gui.standalone_external_link.open_requested",
      "agent.gui.standalone_external_link.open_succeeded",
      "agent.gui.standalone_link_action.settled"
    ]
  );
  assert.equal(JSON.stringify(diagnostics).includes("token=secret"), false);
  assert.deepEqual(diagnostics[1]?.details, {
    urlHost: "example.com",
    urlLength: url.length,
    urlProtocol: "https:"
  });
});

test("standalone Agent logs external opener failures and a declined action", async () => {
  const diagnostics: DesktopRendererDiagnosticPayload[] = [];

  const handled = await runStandaloneAgentLinkAction(
    {
      source: "agent-markdown",
      type: "open-url",
      url: "https://example.com"
    },
    createDependencies({
      diagnostics,
      openExternalUrl: async () => {
        throw new Error("native opener unavailable");
      }
    })
  );

  assert.equal(handled, false);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.event),
    [
      "agent.gui.standalone_link_action.received",
      "agent.gui.standalone_external_link.open_requested",
      "agent.gui.standalone_external_link.open_failed",
      "agent.gui.standalone_link_action.settled"
    ]
  );
  assert.equal(diagnostics[2]?.details?.error, "native opener unavailable");
  assert.equal(diagnostics[2]?.level, "warn");
  assert.equal(diagnostics[3]?.details?.handled, false);
});

function createDependencies(input: {
  diagnostics: DesktopRendererDiagnosticPayload[];
  openExternalUrl(url: string): Promise<void>;
}) {
  return {
    getAgentSession: fail,
    launchAgentGui: fail,
    launchWorkspaceIssueManager: fail,
    launchWorkspaceFiles: fail,
    openExternalUrl: input.openExternalUrl,
    runtimeApi: {
      async logRendererDiagnostic(payload: DesktopRendererDiagnosticPayload) {
        input.diagnostics.push(payload);
      }
    },
    workspaceId: "workspace-1"
  };
}

function fail(): never {
  throw new Error("unexpected dependency call");
}
