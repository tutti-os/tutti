import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopRendererDiagnosticPayload } from "@shared/contracts/ipc.ts";
import { runStandaloneAgentLinkAction } from "./standaloneAgentLinkAction.ts";

test("standalone Agent routes ordinary links to the in-app Browser", async () => {
  const diagnostics: DesktopRendererDiagnosticPayload[] = [];
  const browserUrls: string[] = [];
  const externalUrls: string[] = [];
  const url = "https://example.com/private?token=secret";

  const handled = await runStandaloneAgentLinkAction(
    {
      source: "agent-markdown",
      type: "open-url",
      url
    },
    createDependencies({
      browserUrls,
      diagnostics,
      openExternalUrl: async (target) => {
        externalUrls.push(target);
      }
    })
  );

  assert.equal(handled, true);
  assert.deepEqual(browserUrls, [url]);
  assert.deepEqual(externalUrls, []);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.event),
    [
      "agent.gui.standalone_link_action.received",
      "agent.gui.standalone_link_action.settled"
    ]
  );
  assert.equal(JSON.stringify(diagnostics).includes("token=secret"), false);
});

test("standalone Agent keeps explicit external actions in the system browser", async () => {
  const diagnostics: DesktopRendererDiagnosticPayload[] = [];
  const externalUrls: string[] = [];
  const url = "https://example.com";

  const handled = await runStandaloneAgentLinkAction(
    {
      source: "agent-external-action",
      type: "open-url",
      url
    },
    createDependencies({
      diagnostics,
      openExternalUrl: async (target) => {
        externalUrls.push(target);
      }
    })
  );

  assert.equal(handled, true);
  assert.deepEqual(externalUrls, [url]);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.event),
    [
      "agent.gui.standalone_link_action.received",
      "agent.gui.standalone_link_action.settled"
    ]
  );
});

function createDependencies(input: {
  browserUrls?: string[];
  diagnostics: DesktopRendererDiagnosticPayload[];
  openExternalUrl(url: string): Promise<void>;
}) {
  return {
    getAgentSession: fail,
    launchAgentGui: fail,
    launchWorkspaceIssueManager: fail,
    launchWorkspaceFiles: fail,
    openBrowserUrl: async ({ url }: { url: string }) => {
      input.browserUrls?.push(url);
      return true;
    },
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
