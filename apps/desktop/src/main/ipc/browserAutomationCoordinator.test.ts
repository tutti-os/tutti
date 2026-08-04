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
  const activatedHostIds: number[] = [];
  const ensureCalls: Array<{ agentSessionId: string; workspaceId: string }> =
    [];
  const ensureUserCalls: Array<{ workspaceId: string }> = [];
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
    async ensureUserBrowserHost(input) {
      ensureUserCalls.push(input);
      const host = addHost(
        98,
        { kind: "workspace", workspaceId: input.workspaceId },
        (request) => ({
          nodeId:
            request.action === "create" ? "workspace-page" : request.nodeId,
          ok: true,
          requestId: request.requestId
        })
      );
      announceReady(host);
    },
    runtime: {
      activateHost(sender) {
        activatedHostIds.push((sender as unknown as { id: number }).id);
      },
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

  return {
    activatedHostIds,
    addHost,
    announceReady,
    coordinator,
    ensureCalls,
    ensureUserCalls,
    ipc
  };
}

test("Agent new_page creates and reveals a full User Browser page", async () => {
  const harness = createHarness();
  const workspaceHost = harness.addHost(
    4,
    { kind: "workspace", workspaceId: "workspace-a" },
    (request) => ({
      nodeId: request.action === "create" ? "user-page" : request.nodeId,
      ok: true,
      requestId: request.requestId
    })
  );
  harness.announceReady(workspaceHost);
  const nodeId = await harness.coordinator.requestTarget({
    agentSessionId: "session-a",
    agentTurnId: "turn-a",
    url: "https://example.com",
    workspaceId: "workspace-a"
  });

  assert.equal(nodeId, "user-page");
  assert.deepEqual(harness.ensureCalls, []);
  assert.deepEqual(harness.activatedHostIds, [4]);
  assert.equal(workspaceHost.requests[0]?.surfaceRole, "user");
  assert.equal(workspaceHost.requests[0]?.agentSessionId, "session-a");
  assert.equal(workspaceHost.requests[0]?.agentTurnId, "turn-a");
  assert.equal(workspaceHost.requests[0]?.reveal, true);
  harness.coordinator.dispose();
});

test("Agent new_page opens a workspace Browser host when none is ready", async () => {
  const harness = createHarness();
  const nodeId = await harness.coordinator.requestTarget({
    agentSessionId: "session-a",
    agentTurnId: "turn-a",
    url: "https://example.com",
    workspaceId: "workspace-a"
  });

  assert.equal(nodeId, "workspace-page");
  assert.deepEqual(harness.ensureUserCalls, [{ workspaceId: "workspace-a" }]);
  assert.deepEqual(harness.ensureCalls, []);
  assert.deepEqual(harness.activatedHostIds, [98]);
  harness.coordinator.dispose();
});

test("created targets remain routed to the exact User Browser host that owns them", async () => {
  const harness = createHarness();
  const first = harness.addHost(
    1,
    { kind: "workspace", workspaceId: "workspace-a" },
    (request) => ({
      nodeId: request.action === "create" ? "page-a" : request.nodeId,
      ok: true,
      requestId: request.requestId
    })
  );
  const second = harness.addHost(
    2,
    { kind: "workspace", workspaceId: "workspace-a" },
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
    agentTurnId: "turn-b",
    workspaceId: "workspace-a"
  });
  assert.equal(nodeId, "page-b");
  await harness.coordinator.selectTarget({
    agentSessionId: "session-b",
    nodeId: "page-b",
    selected: true,
    surfaceId: "user-surface",
    surfaceRole: "user",
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
  assert.deepEqual(harness.activatedHostIds, [2]);
  harness.coordinator.dispose();
});

test("Browser page creation without a Turn keeps activating its workspace host", async () => {
  const harness = createHarness();
  const workspaceHost = harness.addHost(
    4,
    { kind: "workspace", workspaceId: "workspace-a" },
    (request) => ({
      nodeId: request.action === "create" ? "user-page" : request.nodeId,
      ok: true,
      requestId: request.requestId
    })
  );
  harness.announceReady(workspaceHost);

  const nodeId = await harness.coordinator.requestTarget({
    agentSessionId: null,
    agentTurnId: null,
    workspaceId: "workspace-a"
  });
  await harness.coordinator.requestTarget({
    agentSessionId: null,
    agentTurnId: null,
    workspaceId: "workspace-a"
  });

  assert.equal(nodeId, "user-page");
  assert.deepEqual(harness.activatedHostIds, [4, 4]);
  assert.deepEqual(
    workspaceHost.requests.map((request) => request.reveal),
    [true, true]
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
  const valid = harness.addHost(
    5,
    { kind: "workspace", workspaceId: "workspace-a" },
    (request) => ({
      nodeId: "valid-page",
      ok: true,
      requestId: request.requestId
    })
  );
  harness.announceReady(valid);

  const nodeId = await harness.coordinator.requestTarget({
    agentSessionId: "session-a",
    agentTurnId: "turn-a",
    workspaceId: "workspace-a"
  });
  assert.equal(nodeId, "valid-page");
  assert.deepEqual(forged.requests, []);
  assert.equal(harness.ensureCalls.length, 0);
  harness.coordinator.dispose();
});

test("Agent new_page activates the Browser host only once per turn", async () => {
  const harness = createHarness();
  const workspaceHost = harness.addHost(
    4,
    { kind: "workspace", workspaceId: "workspace-a" },
    (request) => ({
      nodeId: `page-${request.requestId}`,
      ok: true,
      requestId: request.requestId
    })
  );
  harness.announceReady(workspaceHost);

  await Promise.all(
    ["one", "two", "three"].map((suffix) =>
      harness.coordinator.requestTarget({
        agentSessionId: "session-a",
        agentTurnId: "turn-a",
        url: `https://${suffix}.example`,
        workspaceId: "workspace-a"
      })
    )
  );
  await harness.coordinator.requestTarget({
    agentSessionId: "session-a",
    agentTurnId: "turn-b",
    workspaceId: "workspace-a"
  });

  assert.equal(workspaceHost.requests.length, 4);
  assert.deepEqual(
    workspaceHost.requests.map((request) => request.reveal),
    [true, false, false, true]
  );
  assert.deepEqual(harness.activatedHostIds, [4, 4]);
  harness.coordinator.dispose();
});
