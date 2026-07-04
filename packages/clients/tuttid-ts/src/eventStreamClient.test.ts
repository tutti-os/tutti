import assert from "node:assert/strict";
import test from "node:test";
import { businessEventCatalogRevision } from "@tutti-os/event-protocol";
import { createTuttidEventStreamClient } from "./eventStreamClient.ts";

test("tuttid event stream client dispatches typed topic events", async () => {
  const sockets: FakeEventStreamSocket[] = [];
  const events: unknown[] = [];
  const client = createTuttidEventStreamClient({
    resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
    webSocketFactory(url) {
      const socket = new FakeEventStreamSocket(url);
      sockets.push(socket);
      return socket;
    }
  });

  const unsubscribe = client.subscribe(
    "preferences.desktop.updated",
    (event) => {
      events.push(event);
    }
  );

  const connectPromise = client.connect();
  await Promise.resolve();
  const socket = sockets[0];
  assert.ok(socket);

  socket.emitMessage({
    catalogRevision: businessEventCatalogRevision,
    kind: "ready",
    protocolVersion: 1,
    serverTime: "2026-05-30T08:00:00Z"
  });
  await connectPromise;

  assert.deepEqual(socket.sent, [
    {
      kind: "subscribe",
      requestId: "1",
      topics: ["preferences.desktop.updated"]
    }
  ]);

  socket.emitMessage({
    event: {
      emittedAt: "2026-05-30T08:00:00Z",
      id: "evt-1",
      payload: {
        initialized: true,
        preferences: {
          agentComposerDefaultsByProvider: {},
          agentDockLayout: "legacySplit",
          agentGuiConversationRailCollapsedByProvider: {},
          agentConversationDetailMode: "coding",
          appCatalogChannel: "production",
          defaultAgentProvider: "codex",
          dockPlacement: "bottom",
          dockIconStyle: "flat",
          fileDefaultOpenersByExtension: { html: "defaultBrowser" },
          locale: "zh-CN",
          minimizeAnimation: "scale",
          sleepPreventionMode: "never",
          showAppDeveloperSources: false,
          themeSource: "dark",
          updateChannel: "rc",
          updatePolicy: "prompt"
        }
      },
      topic: "preferences.desktop.updated",
      version: 1
    },
    kind: "event"
  });

  assert.deepEqual(events, [
    {
      emittedAt: "2026-05-30T08:00:00Z",
      id: "evt-1",
      payload: {
        initialized: true,
        preferences: {
          agentComposerDefaultsByProvider: {},
          agentDockLayout: "legacySplit",
          agentGuiConversationRailCollapsedByProvider: {},
          agentConversationDetailMode: "coding",
          appCatalogChannel: "production",
          defaultAgentProvider: "codex",
          dockPlacement: "bottom",
          dockIconStyle: "flat",
          fileDefaultOpenersByExtension: { html: "defaultBrowser" },
          locale: "zh-CN",
          minimizeAnimation: "scale",
          sleepPreventionMode: "never",
          showAppDeveloperSources: false,
          themeSource: "dark",
          updateChannel: "rc",
          updatePolicy: "prompt"
        }
      },
      topic: "preferences.desktop.updated",
      version: 1
    }
  ]);

  unsubscribe();
  assert.deepEqual(socket.sent.at(-1), {
    kind: "unsubscribe",
    requestId: "2",
    topics: ["preferences.desktop.updated"]
  });

  client.dispose();
});

test("tuttid event stream client sends and filters scoped subscriptions", async () => {
  const sockets: FakeEventStreamSocket[] = [];
  const events: unknown[] = [];
  const client = createTuttidEventStreamClient({
    defaultScope: { workspaceId: " workspace-1 " },
    resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
    webSocketFactory(url) {
      const socket = new FakeEventStreamSocket(url);
      sockets.push(socket);
      return socket;
    }
  });

  const unsubscribe = client.subscribe(
    "preferences.desktop.updated",
    (event) => {
      events.push(event);
    }
  );

  const connectPromise = client.connect();
  await Promise.resolve();
  const socket = sockets[0];
  assert.ok(socket);

  socket.emitMessage({
    catalogRevision: businessEventCatalogRevision,
    kind: "ready",
    protocolVersion: 1,
    serverTime: "2026-05-30T08:00:00Z"
  });
  await connectPromise;

  assert.deepEqual(socket.sent, [
    {
      kind: "subscribe",
      requestId: "1",
      scope: { workspaceId: "workspace-1" },
      topics: ["preferences.desktop.updated"]
    }
  ]);

  socket.emitMessage({
    event: {
      emittedAt: "2026-05-30T08:00:00Z",
      id: "evt-1",
      payload: {
        initialized: true,
        preferences: {
          agentComposerDefaultsByProvider: {},
          agentDockLayout: "legacySplit",
          agentGuiConversationRailCollapsedByProvider: {},
          agentConversationDetailMode: "coding",
          appCatalogChannel: "production",
          defaultAgentProvider: "codex",
          dockPlacement: "bottom",
          dockIconStyle: "flat",
          fileDefaultOpenersByExtension: { html: "defaultBrowser" },
          locale: "zh-CN",
          minimizeAnimation: "scale",
          sleepPreventionMode: "never",
          showAppDeveloperSources: false,
          themeSource: "dark",
          updateChannel: "rc",
          updatePolicy: "prompt"
        }
      },
      scope: { workspaceId: "workspace-2" },
      topic: "preferences.desktop.updated",
      version: 1
    },
    kind: "event"
  });
  socket.emitMessage({
    event: {
      emittedAt: "2026-05-30T08:00:01Z",
      id: "evt-2",
      payload: {
        initialized: true,
        preferences: {
          agentComposerDefaultsByProvider: {},
          agentDockLayout: "legacySplit",
          agentGuiConversationRailCollapsedByProvider: {},
          agentConversationDetailMode: "coding",
          appCatalogChannel: "production",
          defaultAgentProvider: "codex",
          dockPlacement: "bottom",
          dockIconStyle: "flat",
          fileDefaultOpenersByExtension: { html: "defaultBrowser" },
          locale: "zh-CN",
          minimizeAnimation: "scale",
          sleepPreventionMode: "never",
          showAppDeveloperSources: false,
          themeSource: "light",
          updateChannel: "rc",
          updatePolicy: "prompt"
        }
      },
      scope: { workspaceId: "workspace-1" },
      topic: "preferences.desktop.updated",
      version: 1
    },
    kind: "event"
  });

  assert.deepEqual(events, [
    {
      emittedAt: "2026-05-30T08:00:01Z",
      id: "evt-2",
      payload: {
        initialized: true,
        preferences: {
          agentComposerDefaultsByProvider: {},
          agentDockLayout: "legacySplit",
          agentGuiConversationRailCollapsedByProvider: {},
          agentConversationDetailMode: "coding",
          appCatalogChannel: "production",
          defaultAgentProvider: "codex",
          dockPlacement: "bottom",
          dockIconStyle: "flat",
          fileDefaultOpenersByExtension: { html: "defaultBrowser" },
          locale: "zh-CN",
          minimizeAnimation: "scale",
          sleepPreventionMode: "never",
          showAppDeveloperSources: false,
          themeSource: "light",
          updateChannel: "rc",
          updatePolicy: "prompt"
        }
      },
      scope: { workspaceId: "workspace-1" },
      topic: "preferences.desktop.updated",
      version: 1
    }
  ]);

  unsubscribe();
  assert.deepEqual(socket.sent.at(-1), {
    kind: "unsubscribe",
    requestId: "2",
    scope: { workspaceId: "workspace-1" },
    topics: ["preferences.desktop.updated"]
  });

  client.dispose();
});

test("tuttid event stream client can opt out of a default scope", async () => {
  const sockets: FakeEventStreamSocket[] = [];
  const events: unknown[] = [];
  const client = createTuttidEventStreamClient({
    defaultScope: { workspaceId: "workspace-1" },
    resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
    webSocketFactory(url) {
      const socket = new FakeEventStreamSocket(url);
      sockets.push(socket);
      return socket;
    }
  });

  const unsubscribe = client.subscribe(
    "preferences.desktop.updated",
    (event) => {
      events.push(event);
    },
    {
      scope: null
    }
  );

  const connectPromise = client.connect();
  await Promise.resolve();
  const socket = sockets[0];
  assert.ok(socket);

  socket.emitMessage({
    catalogRevision: businessEventCatalogRevision,
    kind: "ready",
    protocolVersion: 1,
    serverTime: "2026-05-30T08:00:00Z"
  });
  await connectPromise;

  assert.deepEqual(socket.sent, [
    {
      kind: "subscribe",
      requestId: "1",
      topics: ["preferences.desktop.updated"]
    }
  ]);

  socket.emitMessage({
    event: {
      emittedAt: "2026-05-30T08:00:00Z",
      id: "evt-1",
      payload: {
        initialized: true,
        preferences: {
          agentComposerDefaultsByProvider: {},
          agentDockLayout: "legacySplit",
          agentGuiConversationRailCollapsedByProvider: {},
          agentConversationDetailMode: "coding",
          appCatalogChannel: "production",
          defaultAgentProvider: "codex",
          dockPlacement: "bottom",
          dockIconStyle: "flat",
          fileDefaultOpenersByExtension: { html: "defaultBrowser" },
          locale: "zh-CN",
          minimizeAnimation: "scale",
          sleepPreventionMode: "never",
          showAppDeveloperSources: false,
          themeSource: "dark",
          updateChannel: "rc",
          updatePolicy: "prompt"
        }
      },
      scope: { workspaceId: "workspace-2" },
      topic: "preferences.desktop.updated",
      version: 1
    },
    kind: "event"
  });

  assert.equal(events.length, 1);
  unsubscribe();
  client.dispose();
});

test("tuttid event stream client publishes typed intents after connect", async () => {
  const sockets: FakeEventStreamSocket[] = [];
  const client = createTuttidEventStreamClient({
    resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
    webSocketFactory(url) {
      const socket = new FakeEventStreamSocket(url);
      sockets.push(socket);
      return socket;
    }
  });

  const connectPromise = client.connect();
  await Promise.resolve();
  const socket = sockets[0];
  assert.ok(socket);
  socket.emitMessage({
    catalogRevision: businessEventCatalogRevision,
    kind: "ready",
    protocolVersion: 1,
    serverTime: "2026-05-30T08:00:00Z"
  });
  await connectPromise;

  const publishPromise = client.publishIntent(
    "preferences.desktop.update.requested",
    {
      preferences: {
        agentComposerDefaultsByProvider: {},
        agentDockLayout: "legacySplit",
        agentGuiConversationRailCollapsedByProvider: {},
        agentConversationDetailMode: "coding",
        appCatalogChannel: "production",
        defaultAgentProvider: "codex",
        dockPlacement: "bottom",
        dockIconStyle: "flat",
        fileDefaultOpenersByExtension: { html: "defaultBrowser" },
        locale: "zh-CN",
        minimizeAnimation: "scale",
        sleepPreventionMode: "never",
        showAppDeveloperSources: false,
        themeSource: "dark",
        updateChannel: "rc",
        updatePolicy: "prompt"
      }
    }
  );
  await Promise.resolve();

  assert.deepEqual(socket.sent[0], {
    event: {
      emittedAt: socket.sentEventTimestamps[0],
      id: socket.sentEventIDs[0],
      payload: {
        preferences: {
          agentComposerDefaultsByProvider: {},
          agentDockLayout: "legacySplit",
          agentGuiConversationRailCollapsedByProvider: {},
          agentConversationDetailMode: "coding",
          appCatalogChannel: "production",
          defaultAgentProvider: "codex",
          dockPlacement: "bottom",
          dockIconStyle: "flat",
          fileDefaultOpenersByExtension: { html: "defaultBrowser" },
          locale: "zh-CN",
          minimizeAnimation: "scale",
          sleepPreventionMode: "never",
          showAppDeveloperSources: false,
          themeSource: "dark",
          updateChannel: "rc",
          updatePolicy: "prompt"
        }
      },
      topic: "preferences.desktop.update.requested",
      version: 1
    },
    kind: "publish",
    requestId: "1"
  });

  socket.emitMessage({
    acceptedAt: "2026-05-30T08:00:01Z",
    kind: "ack",
    requestId: "1"
  });

  await publishPromise;
  client.dispose();
  assert.equal(socket.closeCalls.length, 1);
});

test("tuttid event stream client fails handshake on a pre-ready error frame", async () => {
  const sockets: FakeEventStreamSocket[] = [];
  const client = createTuttidEventStreamClient({
    resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
    webSocketFactory(url) {
      const socket = new FakeEventStreamSocket(url);
      sockets.push(socket);
      return socket;
    }
  });

  const connectPromise = client.connect();
  await Promise.resolve();
  const socket = sockets[0];
  assert.ok(socket);

  socket.emitMessage({
    code: "handshake_failed",
    kind: "error",
    message: "handshake failed"
  });

  await assert.rejects(connectPromise, /handshake failed/);
});

test("tuttid event stream client fails handshake on unexpected pre-ready frames", async () => {
  for (const frame of [
    {
      acceptedAt: "2026-05-30T08:00:01Z",
      kind: "ack",
      requestId: "1"
    },
    {
      event: {
        emittedAt: "2026-05-30T08:00:00Z",
        id: "evt-1",
        payload: {
          initialized: true,
          preferences: {
            agentComposerDefaultsByProvider: {},
            agentDockLayout: "legacySplit",
            agentGuiConversationRailCollapsedByProvider: {},
            agentConversationDetailMode: "coding",
            appCatalogChannel: "production",
            defaultAgentProvider: "codex",
            dockPlacement: "bottom",
            dockIconStyle: "flat",
            fileDefaultOpenersByExtension: { html: "defaultBrowser" },
            locale: "zh-CN",
            minimizeAnimation: "scale",
            sleepPreventionMode: "never",
            showAppDeveloperSources: false,
            themeSource: "dark",
            updateChannel: "rc",
            updatePolicy: "prompt"
          }
        },
        topic: "preferences.desktop.updated",
        version: 1
      },
      kind: "event"
    },
    {
      kind: "pong",
      requestId: "1",
      sentAt: "2026-05-30T08:00:01Z"
    }
  ]) {
    const sockets: FakeEventStreamSocket[] = [];
    const client = createTuttidEventStreamClient({
      resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
      webSocketFactory(url) {
        const socket = new FakeEventStreamSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connectPromise = client.connect();
    await Promise.resolve();
    const socket = sockets[0];
    assert.ok(socket);

    socket.emitMessage(frame);

    await assert.rejects(
      connectPromise,
      new RegExp(`unexpected ${String(frame.kind)} frame before ready`)
    );
    assert.deepEqual(socket.closeCalls.at(-1), {
      code: 4002,
      reason: "handshake_failed"
    });
  }
});

test("tuttid event stream client fails handshake on an invalid server frame", async () => {
  const sockets: FakeEventStreamSocket[] = [];
  const client = createTuttidEventStreamClient({
    resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
    webSocketFactory(url) {
      const socket = new FakeEventStreamSocket(url);
      sockets.push(socket);
      return socket;
    }
  });

  const connectPromise = client.connect();
  await Promise.resolve();
  const socket = sockets[0];
  assert.ok(socket);

  socket.emitRawMessage("{not valid json");

  await assert.rejects(connectPromise, /invalid server frame/);
});

test("tuttid event stream client fails handshake on a protocol version mismatch", async () => {
  const sockets: FakeEventStreamSocket[] = [];
  const client = createTuttidEventStreamClient({
    resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
    webSocketFactory(url) {
      const socket = new FakeEventStreamSocket(url);
      sockets.push(socket);
      return socket;
    }
  });

  const connectPromise = client.connect();
  await Promise.resolve();
  const socket = sockets[0];
  assert.ok(socket);

  socket.emitMessage({
    catalogRevision: businessEventCatalogRevision,
    kind: "ready",
    protocolVersion: 99,
    serverTime: "2026-05-30T08:00:00Z"
  });

  await assert.rejects(connectPromise, /protocol version mismatch/);
});

test("tuttid event stream client fails handshake on a catalog revision mismatch", async () => {
  const sockets: FakeEventStreamSocket[] = [];
  const client = createTuttidEventStreamClient({
    resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
    webSocketFactory(url) {
      const socket = new FakeEventStreamSocket(url);
      sockets.push(socket);
      return socket;
    }
  });

  const connectPromise = client.connect();
  await Promise.resolve();
  const socket = sockets[0];
  assert.ok(socket);

  socket.emitMessage({
    catalogRevision: "sha256:stale",
    kind: "ready",
    protocolVersion: 1,
    serverTime: "2026-05-30T08:00:00Z"
  });

  await assert.rejects(connectPromise, /catalog revision mismatch/);
});

test("tuttid event stream client tears down a failed handshake before retrying", async () => {
  const sockets: FakeEventStreamSocket[] = [];
  const client = createTuttidEventStreamClient({
    resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
    webSocketFactory(url) {
      const socket = new FakeEventStreamSocket(url);
      sockets.push(socket);
      return socket;
    }
  });

  const firstConnectPromise = client.connect();
  await Promise.resolve();
  const firstSocket = sockets[0];
  assert.ok(firstSocket);

  firstSocket.emitRawMessage("{not valid json");
  await assert.rejects(firstConnectPromise, /invalid server frame/);
  assert.deepEqual(firstSocket.closeCalls.at(-1), {
    code: 4002,
    reason: "handshake_failed"
  });

  const secondConnectPromise = client.connect();
  await Promise.resolve();
  const secondSocket = sockets[1];
  assert.ok(secondSocket);
  secondSocket.emitMessage({
    catalogRevision: businessEventCatalogRevision,
    kind: "ready",
    protocolVersion: 1,
    serverTime: "2026-05-30T08:00:00Z"
  });
  await secondConnectPromise;

  firstSocket.emitClose(4010, "stale");
  firstSocket.emitMessage({
    acceptedAt: "2026-05-30T08:00:02Z",
    kind: "ack",
    requestId: "999"
  });

  const publishPromise = client.publishIntent(
    "preferences.desktop.update.requested",
    {
      preferences: {
        agentComposerDefaultsByProvider: {},
        agentDockLayout: "legacySplit",
        agentGuiConversationRailCollapsedByProvider: {},
        agentConversationDetailMode: "coding",
        appCatalogChannel: "production",
        defaultAgentProvider: "codex",
        dockPlacement: "bottom",
        dockIconStyle: "flat",
        fileDefaultOpenersByExtension: { html: "defaultBrowser" },
        locale: "zh-CN",
        minimizeAnimation: "scale",
        sleepPreventionMode: "never",
        showAppDeveloperSources: false,
        themeSource: "light",
        updateChannel: "rc",
        updatePolicy: "prompt"
      }
    }
  );
  await Promise.resolve();

  const lastSent = secondSocket.sent.at(-1);
  assert.ok(isRecord(lastSent));
  assert.equal(lastSent.kind, "publish");

  secondSocket.emitMessage({
    acceptedAt: "2026-05-30T08:00:03Z",
    kind: "ack",
    requestId: "1"
  });

  await publishPromise;
  client.dispose();
});

test("tuttid event stream client sends heartbeat pings after ready and clears pong timeout on pong", async () => {
  const sockets: FakeEventStreamSocket[] = [];
  const scheduler = new FakeHeartbeatScheduler();
  const client = createTuttidEventStreamClient({
    heartbeat: scheduler.config,
    resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
    webSocketFactory(url) {
      const socket = new FakeEventStreamSocket(url);
      sockets.push(socket);
      return socket;
    }
  });

  const connectPromise = client.connect();
  await Promise.resolve();
  const socket = sockets[0];
  assert.ok(socket);
  socket.emitMessage({
    catalogRevision: businessEventCatalogRevision,
    kind: "ready",
    protocolVersion: 1,
    serverTime: "2026-05-30T08:00:00Z"
  });
  await connectPromise;

  scheduler.tickInterval();

  const lastSent = socket.sent.at(-1);
  assert.ok(isRecord(lastSent));
  assert.equal(lastSent.kind, "ping");
  assert.equal(lastSent.requestId, "1");
  assert.equal(typeof lastSent.sentAt, "string");
  assert.equal(scheduler.timeoutCount(), 1);

  socket.emitMessage({
    kind: "pong",
    requestId: "1",
    sentAt: "2026-05-30T08:00:01Z"
  });

  assert.equal(scheduler.timeoutCount(), 0);
  client.dispose();
  assert.equal(scheduler.intervalCount(), 0);
});

test("tuttid event stream client closes and resets the socket when pong times out", async () => {
  const sockets: FakeEventStreamSocket[] = [];
  const scheduler = new FakeHeartbeatScheduler();
  const client = createTuttidEventStreamClient({
    heartbeat: scheduler.config,
    resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
    webSocketFactory(url) {
      const socket = new FakeEventStreamSocket(url);
      sockets.push(socket);
      return socket;
    }
  });

  const connectPromise = client.connect();
  await Promise.resolve();
  const socket = sockets[0];
  assert.ok(socket);
  socket.emitMessage({
    catalogRevision: businessEventCatalogRevision,
    kind: "ready",
    protocolVersion: 1,
    serverTime: "2026-05-30T08:00:00Z"
  });
  await connectPromise;

  scheduler.tickInterval();
  scheduler.tickTimeout();

  assert.deepEqual(socket.closeCalls.at(-1), {
    code: 4000,
    reason: "heartbeat_timeout"
  });
  assert.equal(scheduler.intervalCount(), 0);
  assert.equal(scheduler.timeoutCount(), 0);

  const reconnectPromise = client.connect();
  await Promise.resolve();
  const reconnectSocket = sockets[1];
  assert.ok(reconnectSocket);
  reconnectSocket.emitMessage({
    catalogRevision: businessEventCatalogRevision,
    kind: "ready",
    protocolVersion: 1,
    serverTime: "2026-05-30T08:00:05Z"
  });
  await reconnectPromise;
  client.dispose();
});

test("tuttid event stream client reconnects and flushes current subscriptions", async () => {
  const sockets: FakeEventStreamSocket[] = [];
  const reconnectScheduler = new FakeReconnectScheduler();
  const connectionStates: string[] = [];
  const client = createTuttidEventStreamClient({
    reconnect: reconnectScheduler.config,
    resolveUrl: () => "ws://127.0.0.1:4545/v1/events/ws?access_token=token-1",
    webSocketFactory(url) {
      const socket = new FakeEventStreamSocket(url);
      sockets.push(socket);
      return socket;
    }
  });

  client.subscribeConnectionState((state) => {
    connectionStates.push(state);
  });
  const unsubscribe = client.subscribe("preferences.desktop.updated", () => {});
  const connectPromise = client.connect();
  await Promise.resolve();
  const socket = sockets[0];
  assert.ok(socket);
  socket.emitMessage({
    catalogRevision: businessEventCatalogRevision,
    kind: "ready",
    protocolVersion: 1,
    serverTime: "2026-05-30T08:00:00Z"
  });
  await connectPromise;

  socket.emitClose(1006, "network_lost");
  assert.equal(reconnectScheduler.timeoutCount(), 1);
  reconnectScheduler.tickTimeout();
  await Promise.resolve();

  const reconnectSocket = sockets[1];
  assert.ok(reconnectSocket);
  reconnectSocket.emitMessage({
    catalogRevision: businessEventCatalogRevision,
    kind: "ready",
    protocolVersion: 1,
    serverTime: "2026-05-30T08:00:01Z"
  });
  await Promise.resolve();

  assert.deepEqual(reconnectSocket.sent, [
    {
      kind: "subscribe",
      requestId: "2",
      topics: ["preferences.desktop.updated"]
    }
  ]);
  assert.deepEqual(connectionStates, [
    "connecting",
    "connected",
    "disconnected",
    "connecting",
    "connected"
  ]);

  unsubscribe();
  client.dispose();
});

class FakeEventStreamSocket {
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readonly sent: unknown[] = [];
  readonly sentEventIDs: string[] = [];
  readonly sentEventTimestamps: string[] = [];
  readonly url: string;

  private readonly target = new EventTarget();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void;
  addEventListener(
    type: "close" | "error" | "message",
    listener:
      | ((event: CloseEvent) => void)
      | ((event: Event) => void)
      | ((event: MessageEvent) => void)
  ): void {
    this.target.addEventListener(
      type,
      listener as EventListenerOrEventListenerObject
    );
  }
  removeEventListener(
    type: "close",
    listener: (event: CloseEvent) => void
  ): void;
  removeEventListener(type: "error", listener: (event: Event) => void): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void;
  removeEventListener(
    type: "close" | "error" | "message",
    listener:
      | ((event: CloseEvent) => void)
      | ((event: Event) => void)
      | ((event: MessageEvent) => void)
  ): void {
    this.target.removeEventListener(
      type,
      listener as EventListenerOrEventListenerObject
    );
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.target.dispatchEvent(
      new CloseEvent("close", {
        code,
        reason
      })
    );
  }

  emitMessage(payload: unknown): void {
    this.target.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(payload)
      })
    );
  }

  emitRawMessage(data: unknown): void {
    this.target.dispatchEvent(
      new MessageEvent("message", {
        data
      })
    );
  }

  emitError(): void {
    this.target.dispatchEvent(new Event("error"));
  }

  emitClose(code?: number, reason?: string): void {
    this.target.dispatchEvent(
      new CloseEvent("close", {
        code,
        reason
      })
    );
  }

  send(data: string): void {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.kind === "publish" && isRecord(parsed.event)) {
      if (typeof parsed.event.id === "string") {
        this.sentEventIDs.push(parsed.event.id);
      }
      if (typeof parsed.event.emittedAt === "string") {
        this.sentEventTimestamps.push(parsed.event.emittedAt);
      }
    }
    this.sent.push(parsed);
  }
}

class FakeReconnectScheduler {
  readonly config = {
    initialDelayMs: 1,
    maxDelayMs: 1,
    scheduleTimeout: (callback: () => void) => {
      const handle = Symbol("reconnect-timeout");
      this.timeouts.set(handle, callback);
      return () => {
        this.timeouts.delete(handle);
      };
    }
  } satisfies {
    initialDelayMs: number;
    maxDelayMs: number;
    scheduleTimeout: (callback: () => void, delayMs: number) => () => void;
  };

  private readonly timeouts = new Map<symbol, () => void>();

  tickTimeout(): void {
    const entry = this.timeouts.entries().next().value;
    assert.ok(entry);
    const [handle, callback] = entry;
    this.timeouts.delete(handle);
    callback();
  }

  timeoutCount(): number {
    return this.timeouts.size;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class FakeHeartbeatScheduler {
  readonly config = {
    pingIntervalMs: 25,
    pongTimeoutMs: 10,
    scheduleInterval: (callback: () => void) => {
      const handle = Symbol("interval");
      this.intervals.set(handle, callback);
      return () => {
        this.intervals.delete(handle);
      };
    },
    scheduleTimeout: (callback: () => void) => {
      const handle = Symbol("timeout");
      this.timeouts.set(handle, callback);
      return () => {
        this.timeouts.delete(handle);
      };
    }
  } satisfies {
    pingIntervalMs: number;
    pongTimeoutMs: number;
    scheduleInterval: (callback: () => void, delayMs: number) => () => void;
    scheduleTimeout: (callback: () => void, delayMs: number) => () => void;
  };

  private readonly intervals = new Map<symbol, () => void>();
  private readonly timeouts = new Map<symbol, () => void>();

  intervalCount(): number {
    return this.intervals.size;
  }

  tickInterval(): void {
    const callback = this.intervals.values().next().value;
    assert.ok(callback);
    callback();
  }

  tickTimeout(): void {
    const entry = this.timeouts.entries().next().value;
    assert.ok(entry);
    const [handle, callback] = entry;
    this.timeouts.delete(handle);
    callback();
  }

  timeoutCount(): number {
    return this.timeouts.size;
  }
}
