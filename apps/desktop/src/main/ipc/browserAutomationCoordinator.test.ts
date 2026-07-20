import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type {
  DesktopBrowserAutomationRequest,
  DesktopBrowserAutomationResponse
} from "../../shared/contracts/ipc.ts";
import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import { createDesktopBrowserAutomationCoordinator } from "./browserAutomationCoordinator.ts";

interface FakeHost {
  context: { kind: "agent" | "workspace"; workspaceId: string };
  destroyed: boolean;
  id: number;
  requests: DesktopBrowserAutomationRequest[];
}

function createHarness() {
  const ipc = new EventEmitter();
  const hosts = new Map<number, FakeHost>();
  let nextRequestId = 0;
  const ensureCalls: Array<{ agentSessionId: string; workspaceId: string }> =
    [];
  const responses = new Map<
    number,
    (
      request: DesktopBrowserAutomationRequest
    ) => DesktopBrowserAutomationResponse
  >();

  const sender = (host: FakeHost) =>
    ({
      id: host.id,
      isDestroyed: () => host.destroyed,
      send(_channel: string, request: DesktopBrowserAutomationRequest) {
        host.requests.push(request);
        const response = responses.get(host.id)?.(request);
        if (response) {
          queueMicrotask(() =>
            ipc.emit(
              desktopIpcChannels.browser.automationResponse,
              { sender: sender(host) },
              response
            )
          );
        }
      }
    }) as never;

  const addHost = (
    id: number,
    context: FakeHost["context"],
    respond: (
      request: DesktopBrowserAutomationRequest
    ) => DesktopBrowserAutomationResponse
  ): FakeHost => {
    const host = { context, destroyed: false, id, requests: [] };
    hosts.set(id, host);
    responses.set(id, respond);
    return host;
  };

  const announceReady = (
    host: FakeHost,
    input = {
      surfaceRole:
        host.context.kind === "agent" ? ("agent" as const) : ("user" as const),
      workspaceId: host.context.workspaceId
    }
  ) => {
    ipc.emit(
      desktopIpcChannels.browser.automationHostReady,
      { sender: sender(host) },
      input
    );
  };

  const coordinator = createDesktopBrowserAutomationCoordinator({
    async ensureAgentBrowserHost(input) {
      ensureCalls.push(input);
      const host = addHost(
        99,
        { kind: "agent", workspaceId: input.workspaceId },
        (request) => ({
          nodeId:
            request.action === "create" ? "background-page" : request.nodeId,
          ok: true,
          requestId: request.requestId
        })
      );
      announceReady(host);
    },
    runtime: {
      ipc: ipc as never,
      randomId: () => `request-${++nextRequestId}`,
      resolveHostContext: (webContents) =>
        hosts.get((webContents as unknown as { id: number }).id)?.context ??
        null,
      resolveWebContents: (id) => {
        const host = hosts.get(id);
        return host ? sender(host) : null;
      }
    }
  });

  return { addHost, announceReady, coordinator, ensureCalls, ipc };
}

test("Agent new_page starts and waits for a background Browser host", async () => {
  const harness = createHarness();
  const nodeId = await harness.coordinator.requestTarget({
    agentSessionId: "session-a",
    url: "https://example.com",
    workspaceId: "workspace-a"
  });

  assert.equal(nodeId, "background-page");
  assert.deepEqual(harness.ensureCalls, [
    { agentSessionId: "session-a", workspaceId: "workspace-a" }
  ]);
  harness.coordinator.dispose();
});

test("created targets remain routed to the exact Agent host that owns them", async () => {
  const harness = createHarness();
  const first = harness.addHost(
    1,
    { kind: "agent", workspaceId: "workspace-a" },
    (request) => ({
      nodeId: request.action === "create" ? "page-a" : request.nodeId,
      ok: true,
      requestId: request.requestId
    })
  );
  const second = harness.addHost(
    2,
    { kind: "agent", workspaceId: "workspace-a" },
    (request) => ({
      nodeId: request.action === "create" ? "page-b" : request.nodeId,
      ok: true,
      requestId: request.requestId
    })
  );
  harness.announceReady(first);
  harness.announceReady(second);

  const nodeId = await harness.coordinator.requestTarget({
    agentSessionId: "session-b",
    workspaceId: "workspace-a"
  });
  assert.equal(nodeId, "page-b");
  await harness.coordinator.selectTarget({
    agentSessionId: "session-b",
    nodeId: "page-b",
    selected: true,
    surfaceId: "agent-surface",
    surfaceRole: "agent",
    tabId: "page-b",
    title: "",
    url: "about:blank",
    workspaceId: "workspace-a"
  });

  assert.deepEqual(first.requests, []);
  assert.deepEqual(
    second.requests.map((request) => request.action),
    ["create", "select"]
  );
  harness.coordinator.dispose();
});

test("ready announcements cannot claim another workspace or surface role", async () => {
  const harness = createHarness();
  const forged = harness.addHost(
    3,
    { kind: "workspace", workspaceId: "workspace-a" },
    (request) => ({
      nodeId: "forged-page",
      ok: true,
      requestId: request.requestId
    })
  );
  harness.announceReady(forged, {
    surfaceRole: "agent",
    workspaceId: "workspace-b"
  });

  const nodeId = await harness.coordinator.requestTarget({
    agentSessionId: "session-a",
    workspaceId: "workspace-a"
  });
  assert.equal(nodeId, "background-page");
  assert.deepEqual(forged.requests, []);
  assert.equal(harness.ensureCalls.length, 1);
  harness.coordinator.dispose();
});
