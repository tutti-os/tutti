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

  const claimTurn = (
    host: FakeHost,
    input: {
      agentSessionId: string;
      agentTurnId: string;
      workspaceId: string;
    }
  ) => {
    ipc.emit(
      desktopIpcChannels.browser.automationTurnClaim,
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
    },
    turnClaimWaitTimeoutMs: 5
  });

  return {
    activatedHostIds,
    addHost,
    announceReady,
    claimTurn,
    coordinator,
    ensureCalls,
    ensureUserCalls,
    ipc
  };
}

test("Agent new_page uses the ready standalone Agent Browser surface", async () => {
  const harness = createHarness();
  const agentHost = harness.addHost(
    4,
    { kind: "agent", workspaceId: "workspace-a" },
    (request) => ({
      nodeId: request.action === "create" ? "user-page" : request.nodeId,
      ok: true,
      requestId: request.requestId
    })
  );
  harness.announceReady(agentHost);
  harness.claimTurn(agentHost, {
    agentSessionId: "session-a",
    agentTurnId: "turn-a",
    workspaceId: "workspace-a"
  });
  const nodeId = await harness.coordinator.requestTarget({
    agentSessionId: "session-a",
    agentTurnId: "turn-a",
    url: "https://example.com",
    workspaceId: "workspace-a"
  });

  assert.equal(nodeId, "user-page");
  assert.deepEqual(harness.ensureCalls, []);
  assert.deepEqual(harness.activatedHostIds, [4]);
  assert.equal(agentHost.requests[0]?.surfaceRole, "agent");
  assert.equal(agentHost.requests[0]?.agentSessionId, "session-a");
  assert.equal(agentHost.requests[0]?.agentTurnId, "turn-a");
  assert.equal(agentHost.requests[0]?.reveal, true);
  harness.coordinator.dispose();
});

test("Agent new_page creates an Agent Browser host when its originating window is not ready", async () => {
  const harness = createHarness();
  const agentHost = harness.addHost(
    4,
    { kind: "agent", workspaceId: "workspace-a" },
    () => ({ nodeId: null, ok: true, requestId: "unused" })
  );
  harness.claimTurn(agentHost, {
    agentSessionId: "session-a",
    agentTurnId: "turn-a",
    workspaceId: "workspace-a"
  });
  const nodeId = await harness.coordinator.requestTarget({
    agentSessionId: "session-a",
    agentTurnId: "turn-a",
    url: "https://example.com",
    workspaceId: "workspace-a"
  });

  assert.equal(nodeId, "background-page");
  assert.deepEqual(harness.ensureCalls, [
    { agentSessionId: "session-a", workspaceId: "workspace-a" }
  ]);
  assert.deepEqual(harness.ensureUserCalls, []);
  assert.deepEqual(harness.activatedHostIds, [99]);
  harness.coordinator.dispose();
});

test("Agent new_page waits for a canonical Turn claim that arrives after the request", async () => {
  const harness = createHarness();
  const agentHost = harness.addHost(
    4,
    { kind: "agent", workspaceId: "workspace-a" },
    () => ({ nodeId: null, ok: true, requestId: "unused" })
  );
  const pendingNodeId = harness.coordinator.requestTarget({
    agentSessionId: "session-a",
    agentTurnId: "turn-a",
    workspaceId: "workspace-a"
  });

  harness.claimTurn(agentHost, {
    agentSessionId: "session-a",
    agentTurnId: "turn-a",
    workspaceId: "workspace-a"
  });

  assert.equal(await pendingNodeId, "background-page");
  assert.deepEqual(harness.ensureCalls, [
    { agentSessionId: "session-a", workspaceId: "workspace-a" }
  ]);
  assert.deepEqual(harness.ensureUserCalls, []);
  harness.coordinator.dispose();
});

test("Workspace-originated Turn stays in Workspace Browser while an Agent host is ready", async () => {
  const harness = createHarness();
  const workspaceHost = harness.addHost(
    3,
    { kind: "workspace", workspaceId: "workspace-a" },
    () => ({ nodeId: null, ok: true, requestId: "unused" })
  );
  const agentHost = harness.addHost(
    4,
    { kind: "agent", workspaceId: "workspace-a" },
    (request) => ({
      nodeId: "wrong-agent-page",
      ok: true,
      requestId: request.requestId
    })
  );
  harness.announceReady(agentHost);
  harness.claimTurn(workspaceHost, {
    agentSessionId: "session-a",
    agentTurnId: "turn-a",
    workspaceId: "workspace-a"
  });

  const nodeId = await harness.coordinator.requestTarget({
    agentSessionId: "session-a",
    agentTurnId: "turn-a",
    url: "https://example.com",
    workspaceId: "workspace-a"
  });

  assert.equal(nodeId, "workspace-page");
  assert.deepEqual(harness.ensureUserCalls, [{ workspaceId: "workspace-a" }]);
  assert.deepEqual(agentHost.requests, []);
  harness.coordinator.dispose();
});

test("unclaimed legacy Turn keeps the Workspace Browser fallback", async () => {
  const harness = createHarness();
  const nodeId = await harness.coordinator.requestTarget({
    agentSessionId: "session-a",
    agentTurnId: "turn-a",
    workspaceId: "workspace-a"
  });

  assert.equal(nodeId, "workspace-page");
  assert.deepEqual(harness.ensureUserCalls, [{ workspaceId: "workspace-a" }]);
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
  const agentHost = harness.addHost(
    4,
    { kind: "agent", workspaceId: "workspace-a" },
    (request) => ({
      nodeId: `page-${request.requestId}`,
      ok: true,
      requestId: request.requestId
    })
  );
  harness.announceReady(agentHost);
  for (const agentTurnId of ["turn-a", "turn-b"]) {
    harness.claimTurn(agentHost, {
      agentSessionId: "session-a",
      agentTurnId,
      workspaceId: "workspace-a"
    });
  }

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

  assert.equal(agentHost.requests.length, 4);
  assert.deepEqual(
    agentHost.requests.map((request) => request.reveal),
    [true, false, false, true]
  );
  assert.deepEqual(harness.activatedHostIds, [4, 4]);
  harness.coordinator.dispose();
});
