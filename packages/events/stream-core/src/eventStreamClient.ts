// Transport core for the business event stream (daemon ↔ renderer over WS).
//
// This is catalog-agnostic infrastructure: connect / heartbeat / reconnect /
// frame send-recv / subscription registry / connection-state. It knows nothing
// about concrete topics or scope axes — those are injected via `protocol`
// (see EventStreamProtocol). Each product (tutti workspace, tsh chat) binds its
// own protocol and topic/scope types on top.

export type EventStreamConnectionState =
  | "connected"
  | "connecting"
  | "disconnected"
  | "disposed";

export interface EventStreamSocket {
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void;
  removeEventListener(
    type: "close",
    listener: (event: CloseEvent) => void
  ): void;
  removeEventListener(type: "error", listener: (event: Event) => void): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export type EventStreamSocketFactory = (url: string) => EventStreamSocket;

type TimerCleanup = () => void;

export interface EventStreamHeartbeatConfig {
  pingIntervalMs: number;
  pongTimeoutMs: number;
  scheduleInterval: (callback: () => void, delayMs: number) => TimerCleanup;
  scheduleTimeout: (callback: () => void, delayMs: number) => TimerCleanup;
}

export interface EventStreamReconnectConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  scheduleTimeout: (callback: () => void, delayMs: number) => TimerCleanup;
}

// Wire frame shapes. Structure is fixed; the carried event payload and the
// scope object are parameterized so each product can bind concrete types.
export type EventStreamClientFrame<TClientEvent, TScope> =
  | { kind: "subscribe"; requestId: string; topics: string[]; scope?: TScope }
  | { kind: "unsubscribe"; requestId: string; topics: string[]; scope?: TScope }
  | { kind: "publish"; requestId: string; event: TClientEvent }
  | { kind: "ping"; requestId: string; sentAt: string };

export type EventStreamServerFrame<TServerEvent> =
  | {
      kind: "ready";
      protocolVersion: number;
      catalogRevision: string;
      serverTime?: string;
    }
  | { kind: "ack"; requestId: string; acceptedAt?: string }
  | { kind: "error"; requestId?: string; code?: string; message?: string }
  | { kind: "event"; event: TServerEvent }
  | { kind: "pong"; requestId: string; sentAt?: string };

// Server events must expose the topic they belong to and (optionally) the scope
// they were published to, so the core can route + filter them.
export interface EventStreamServerEvent<TScope> {
  topic: string;
  scope?: TScope;
}

// The product-specific seam. Everything catalog-aware lives here and is injected
// into the transport core, which never imports a concrete catalog.
export interface EventStreamProtocol<TClientEvent, TScope> {
  protocolVersion: number;
  catalogRevision: string;
  // Validate-or-throw. The core casts after a successful validation.
  assertValidClientFrame(frame: unknown): void;
  assertValidServerFrame(frame: unknown): void;
  createClientEvent(topic: string, payload: unknown): TClientEvent;
  // Scope strategy (was hardcoded to workspaceId in the tutti monolith).
  normalizeScope(scope: TScope | undefined): TScope | undefined;
  // Canonical serialization of a scope for the subscription-key (scope half only;
  // the core prepends the topic).
  scopeKey(scope: TScope | undefined): string;
  eventMatchesScope(
    eventScope: TScope | undefined,
    subscriptionScope: TScope | undefined
  ): boolean;
}

export interface CreateEventStreamClientInput<TClientEvent, TScope> {
  protocol: EventStreamProtocol<TClientEvent, TScope>;
  resolveUrl: () => Promise<string> | string;
  defaultScope?: TScope;
  webSocketFactory?: EventStreamSocketFactory;
  heartbeat?: Partial<EventStreamHeartbeatConfig>;
  reconnect?: false | Partial<EventStreamReconnectConfig>;
}

export interface EventStreamClient<TServerEvent, TScope> {
  connect(): Promise<void>;
  dispose(): void;
  publishIntent(topic: string, payload: unknown): Promise<void>;
  subscribe(
    topic: string,
    listener: (event: TServerEvent) => void,
    options?: { scope?: TScope | null }
  ): () => void;
  subscribeConnectionState(
    listener: (state: EventStreamConnectionState) => void
  ): () => void;
}

interface PendingPublish {
  reject: (error: Error) => void;
  resolve: () => void;
}

interface EventSubscriptionEntry<TServerEvent, TScope> {
  listeners: Set<(event: TServerEvent) => void>;
  scope?: TScope;
  topic: string;
}

type ParsedServerFrame<TServerEvent> =
  | { frame: EventStreamServerFrame<TServerEvent>; ok: true }
  | { error: Error; ok: false };

interface SocketListeners {
  close: (event: CloseEvent) => void;
  error: (event: Event) => void;
  message: (event: MessageEvent) => void;
}

const defaultHeartbeatConfig: EventStreamHeartbeatConfig = {
  pingIntervalMs: 15_000,
  pongTimeoutMs: 10_000,
  scheduleInterval: (callback, delayMs) => {
    const handle = globalThis.setInterval(callback, delayMs);
    return () => {
      globalThis.clearInterval(handle);
    };
  },
  scheduleTimeout: (callback, delayMs) => {
    const handle = globalThis.setTimeout(callback, delayMs);
    return () => {
      globalThis.clearTimeout(handle);
    };
  }
};
const handshakeFailureCloseCode = 4002;

const defaultReconnectConfig: EventStreamReconnectConfig = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  scheduleTimeout: (callback, delayMs) => {
    const handle = globalThis.setTimeout(callback, delayMs);
    return () => {
      globalThis.clearTimeout(handle);
    };
  }
};

export function createEventStreamClient<
  TClientEvent,
  TServerEvent extends EventStreamServerEvent<TScope>,
  TScope
>(
  input: CreateEventStreamClientInput<TClientEvent, TScope>
): EventStreamClient<TServerEvent, TScope> {
  const { protocol } = input;
  const webSocketFactory =
    input.webSocketFactory ?? defaultEventStreamSocketFactory;
  const heartbeat = {
    ...defaultHeartbeatConfig,
    ...input.heartbeat
  };
  const defaultScope = protocol.normalizeScope(input.defaultScope);
  const subscriptions = new Map<
    string,
    EventSubscriptionEntry<TServerEvent, TScope>
  >();
  const pendingPublishes = new Map<string, PendingPublish>();
  const connectionStateListeners = new Set<
    (state: EventStreamConnectionState) => void
  >();
  const reconnect =
    input.reconnect === false
      ? null
      : {
          ...defaultReconnectConfig,
          ...input.reconnect
        };
  let socket: EventStreamSocket | null = null;
  let connectPromise: Promise<void> | null = null;
  let ready = false;
  let disposed = false;
  let nextRequestID = 1;
  let heartbeatIntervalCleanup: TimerCleanup | null = null;
  let pongTimeoutCleanup: TimerCleanup | null = null;
  let reconnectCleanup: TimerCleanup | null = null;
  let reconnectAttempt = 0;
  let awaitingPong = false;

  return {
    connect() {
      return connectInternal();
    },
    dispose() {
      disposed = true;
      cancelReconnect();
      const activeSocket = socket;
      if (!activeSocket) {
        connectPromise = null;
        ready = false;
        notifyConnectionState("disposed");
        return;
      }

      resetSocketState(activeSocket);
      rejectPendingPublishes(new Error("Event stream was disposed."));
      activeSocket.close(1000, "disposed");
      notifyConnectionState("disposed");
    },
    async publishIntent(topic, payload) {
      await this.connect();

      const activeSocket = socket;
      if (!activeSocket || !ready) {
        throw new Error("Event stream is not connected.");
      }

      const requestId = createRequestID();
      const completion = createPendingPublishCompletion(requestId);
      pendingPublishes.set(requestId, completion);

      const frame: EventStreamClientFrame<TClientEvent, TScope> = {
        event: protocol.createClientEvent(topic, payload),
        kind: "publish",
        requestId
      };
      protocol.assertValidClientFrame(frame);
      activeSocket.send(JSON.stringify(frame));

      return await completion.promise;
    },
    subscribe(topic, listener, options) {
      const scope =
        options?.scope === null
          ? undefined
          : protocol.normalizeScope(options?.scope ?? defaultScope);
      const key = createSubscriptionKey(topic, scope);
      let subscription = subscriptions.get(key);
      if (!subscription) {
        subscription = {
          listeners: new Set(),
          scope,
          topic
        };
        subscriptions.set(key, subscription);
      }

      subscription.listeners.add(listener);
      flushSubscription(subscription);

      return () => {
        const currentSubscription = subscriptions.get(key);
        if (!currentSubscription) {
          return;
        }

        currentSubscription.listeners.delete(listener);
        if (currentSubscription.listeners.size === 0) {
          subscriptions.delete(key);
          flushUnsubscription(currentSubscription);
        }
      };
    },
    subscribeConnectionState(listener) {
      connectionStateListeners.add(listener);
      return () => {
        connectionStateListeners.delete(listener);
      };
    }
  };

  function connectInternal(): Promise<void> {
    if (disposed) {
      return Promise.reject(new Error("Event stream was disposed."));
    }
    cancelReconnect();
    if (connectPromise) {
      return connectPromise;
    }

    connectPromise = (async () => {
      notifyConnectionState("connecting");
      const url = await input.resolveUrl();
      const nextSocket = webSocketFactory(url);
      socket = nextSocket;
      ready = false;

      return await new Promise<void>((resolve, reject) => {
        let settled = false;
        let listeners: SocketListeners | null = null;

        const fail = (error: Error) => {
          if (settled) {
            return;
          }

          settled = true;
          detachSocketListeners(nextSocket, listeners);
          listeners = null;
          resetSocketState(nextSocket);
          nextSocket.close(handshakeFailureCloseCode, "handshake_failed");
          scheduleReconnect();
          reject(error);
        };

        const messageListener = (event: MessageEvent) => {
          const parsedFrame = parseServerFrame(event.data);
          if (!parsedFrame.ok) {
            if (!ready) {
              fail(parsedFrame.error);
            }
            return;
          }

          const frame = parsedFrame.frame;

          if (!ready) {
            if (frame.kind !== "ready") {
              fail(
                frame.kind === "error"
                  ? createFrameError(frame)
                  : new Error(
                      `Event stream received an unexpected ${frame.kind} frame before ready.`
                    )
              );
              return;
            }

            if (frame.protocolVersion !== protocol.protocolVersion) {
              fail(
                new Error(
                  `Event stream protocol version mismatch. Expected ${String(protocol.protocolVersion)}, received ${String(frame.protocolVersion)}.`
                )
              );
              return;
            }

            if (frame.catalogRevision !== protocol.catalogRevision) {
              fail(
                new Error(
                  `Event stream catalog revision mismatch. Expected ${protocol.catalogRevision}, received ${frame.catalogRevision}.`
                )
              );
              return;
            }

            ready = true;
            reconnectAttempt = 0;
            flushSubscriptions();
            startHeartbeat(nextSocket);
            notifyConnectionState("connected");
            if (!settled) {
              settled = true;
              resolve();
            }
            return;
          }

          handleServerFrame(frame);
        };
        const errorListener = () => {
          if (!ready) {
            fail(new Error("Event stream connection failed."));
          }
        };
        const closeListener = (event: CloseEvent) => {
          const closeError = createCloseError(event);
          if (!ready) {
            fail(closeError);
            return;
          }

          detachSocketListeners(nextSocket, listeners);
          listeners = null;
          resetSocketState(nextSocket);
          rejectPendingPublishes(closeError);
          scheduleReconnect();
        };

        listeners = {
          close: closeListener,
          error: errorListener,
          message: messageListener
        };

        nextSocket.addEventListener("message", messageListener);
        nextSocket.addEventListener("error", errorListener);
        nextSocket.addEventListener("close", closeListener);
      });
    })();

    connectPromise.catch(() => {});
    return connectPromise;
  }

  function createRequestID(): string {
    return String(nextRequestID++);
  }

  function createSubscriptionKey(
    topic: string,
    scope: TScope | undefined
  ): string {
    return `${topic}\n${protocol.scopeKey(scope)}`;
  }

  function createPendingPublishCompletion(requestId: string): PendingPublish & {
    promise: Promise<void>;
  } {
    let rejectFn: (error: Error) => void = () => {};
    let resolveFn: () => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = () => {
        pendingPublishes.delete(requestId);
        resolve();
      };
      rejectFn = (error) => {
        pendingPublishes.delete(requestId);
        reject(error);
      };
    });

    return {
      promise,
      reject: rejectFn,
      resolve: resolveFn
    };
  }

  function flushSubscriptions() {
    if (!socket || !ready) {
      return;
    }

    for (const subscription of subscriptions.values()) {
      flushSubscription(subscription);
    }
  }

  function flushSubscription(
    subscription: EventSubscriptionEntry<TServerEvent, TScope>
  ): void {
    if (!socket || !ready) {
      return;
    }
    const subscribeFrame: EventStreamClientFrame<TClientEvent, TScope> = {
      kind: "subscribe",
      requestId: createRequestID(),
      topics: [subscription.topic]
    };
    if (subscription.scope) {
      subscribeFrame.scope = subscription.scope;
    }
    protocol.assertValidClientFrame(subscribeFrame);
    socket.send(JSON.stringify(subscribeFrame));
  }

  function flushUnsubscription(
    subscription: EventSubscriptionEntry<TServerEvent, TScope>
  ): void {
    if (!socket || !ready) {
      return;
    }
    const unsubscribeFrame: EventStreamClientFrame<TClientEvent, TScope> = {
      kind: "unsubscribe",
      requestId: createRequestID(),
      topics: [subscription.topic]
    };
    if (subscription.scope) {
      unsubscribeFrame.scope = subscription.scope;
    }
    protocol.assertValidClientFrame(unsubscribeFrame);
    socket.send(JSON.stringify(unsubscribeFrame));
  }

  function handleServerFrame(
    frame: EventStreamServerFrame<TServerEvent>
  ): void {
    switch (frame.kind) {
      case "ack": {
        pendingPublishes.get(frame.requestId)?.resolve();
        return;
      }
      case "error": {
        if (frame.requestId) {
          pendingPublishes
            .get(frame.requestId)
            ?.reject(createFrameError(frame));
        }
        return;
      }
      case "event": {
        for (const subscription of subscriptions.values()) {
          if (
            subscription.topic !== frame.event.topic ||
            !protocol.eventMatchesScope(frame.event.scope, subscription.scope)
          ) {
            continue;
          }
          for (const topicListener of subscription.listeners) {
            topicListener(frame.event);
          }
        }
        return;
      }
      case "pong":
        resolveHeartbeatPong();
        return;
      case "ready":
        return;
    }
  }

  function rejectPendingPublishes(error: Error): void {
    for (const pendingPublish of pendingPublishes.values()) {
      pendingPublish.reject(error);
    }
    pendingPublishes.clear();
  }

  function resetSocketState(nextSocket: EventStreamSocket): void {
    if (socket === nextSocket) {
      socket = null;
    }
    connectPromise = null;
    ready = false;
    stopHeartbeat();
    if (!disposed) {
      notifyConnectionState("disconnected");
    }
  }

  function startHeartbeat(activeSocket: EventStreamSocket): void {
    stopHeartbeat();
    heartbeatIntervalCleanup = heartbeat.scheduleInterval(() => {
      if (!ready || socket !== activeSocket || awaitingPong) {
        return;
      }

      const pingFrame: EventStreamClientFrame<TClientEvent, TScope> = {
        kind: "ping",
        requestId: createRequestID(),
        sentAt: new Date().toISOString()
      };
      protocol.assertValidClientFrame(pingFrame);
      activeSocket.send(JSON.stringify(pingFrame));
      awaitingPong = true;
      pongTimeoutCleanup = heartbeat.scheduleTimeout(() => {
        if (socket !== activeSocket || !awaitingPong) {
          return;
        }

        activeSocket.close(4000, "heartbeat_timeout");
      }, heartbeat.pongTimeoutMs);
    }, heartbeat.pingIntervalMs);
  }

  function resolveHeartbeatPong(): void {
    awaitingPong = false;
    if (pongTimeoutCleanup) {
      pongTimeoutCleanup();
      pongTimeoutCleanup = null;
    }
  }

  function stopHeartbeat(): void {
    awaitingPong = false;
    if (heartbeatIntervalCleanup) {
      heartbeatIntervalCleanup();
      heartbeatIntervalCleanup = null;
    }
    if (pongTimeoutCleanup) {
      pongTimeoutCleanup();
      pongTimeoutCleanup = null;
    }
  }

  function scheduleReconnect(): void {
    if (!reconnect || disposed || reconnectCleanup !== null) {
      return;
    }
    reconnectAttempt += 1;
    const delayMs = Math.min(
      reconnect.initialDelayMs * 2 ** Math.max(0, reconnectAttempt - 1),
      reconnect.maxDelayMs
    );
    reconnectCleanup = reconnect.scheduleTimeout(() => {
      reconnectCleanup = null;
      void connectInternal().catch(() => {
        scheduleReconnect();
      });
    }, delayMs);
  }

  function cancelReconnect(): void {
    if (!reconnectCleanup) {
      return;
    }
    reconnectCleanup();
    reconnectCleanup = null;
  }

  function notifyConnectionState(state: EventStreamConnectionState): void {
    for (const listener of connectionStateListeners) {
      listener(state);
    }
  }

  function parseServerFrame(data: unknown): ParsedServerFrame<TServerEvent> {
    if (typeof data !== "string") {
      return {
        error: new Error(
          "Event stream received a non-text server frame during handshake."
        ),
        ok: false
      };
    }

    try {
      const frame = JSON.parse(data) as unknown;
      const readyMismatchError = getReadyCompatibilityError(frame);
      if (readyMismatchError) {
        return {
          error: readyMismatchError,
          ok: false
        };
      }

      protocol.assertValidServerFrame(frame);
      return {
        frame: frame as EventStreamServerFrame<TServerEvent>,
        ok: true
      };
    } catch {
      return {
        error: new Error(
          "Event stream received an invalid server frame during handshake."
        ),
        ok: false
      };
    }
  }

  function getReadyCompatibilityError(frame: unknown): Error | null {
    if (!isRecord(frame) || frame.kind !== "ready") {
      return null;
    }

    if (frame.protocolVersion !== protocol.protocolVersion) {
      return new Error(
        `Event stream protocol version mismatch. Expected ${protocol.protocolVersion}, received ${String(frame.protocolVersion)}.`
      );
    }

    if (frame.catalogRevision !== protocol.catalogRevision) {
      return new Error(
        `Event stream catalog revision mismatch. Expected ${protocol.catalogRevision}, received ${String(frame.catalogRevision)}.`
      );
    }

    return null;
  }
}

function defaultEventStreamSocketFactory(url: string): EventStreamSocket {
  return new WebSocket(url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function detachSocketListeners(
  socket: EventStreamSocket,
  listeners: SocketListeners | null
): void {
  if (!listeners) {
    return;
  }

  socket.removeEventListener("message", listeners.message);
  socket.removeEventListener("error", listeners.error);
  socket.removeEventListener("close", listeners.close);
}

function createCloseError(event: CloseEvent): Error {
  const suffix = event.reason ? `: ${event.reason}` : "";
  return new Error(`Event stream closed (${event.code || 1006})${suffix}.`);
}

function createFrameError(frame: { code?: string; message?: string }): Error {
  return new Error(frame.message || frame.code || "Event stream error.");
}
