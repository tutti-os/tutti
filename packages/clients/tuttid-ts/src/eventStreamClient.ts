// Tutti binding of the catalog-agnostic transport core (@tutti-os/event-stream-core).
//
// The transport logic (connect / heartbeat / reconnect / frame send-recv /
// subscription registry) lives in the core package. This module only injects the
// tutti workspace protocol (validators, version/revision, workspaceId scope
// strategy, client-event construction) and re-exposes the strongly typed
// `TuttidEventStreamClient` surface so existing callers are unchanged.

import {
  createEventStreamClient,
  type EventStreamConnectionState,
  type EventStreamHeartbeatConfig,
  type EventStreamProtocol,
  type EventStreamReconnectConfig,
  type EventStreamSocketFactory
} from "@tutti-os/event-stream-core";
import {
  assertValidClientFrame,
  assertValidServerFrame,
  businessEventCatalogRevision,
  businessEventProtocolVersion,
  type BusinessEventScopeV1,
  type ClientToServerEventTopic,
  type ClientToServerEventV1,
  type ServerToClientEventTopic,
  type ServerToClientEventV1
} from "@tutti-os/event-protocol";

export interface CreateTuttidEventStreamClientInput {
  defaultScope?: BusinessEventScopeV1;
  resolveUrl: () => Promise<string> | string;
  webSocketFactory?: EventStreamSocketFactory;
  heartbeat?: Partial<EventStreamHeartbeatConfig>;
  reconnect?: false | Partial<EventStreamReconnectConfig>;
}

type ClientEventByTopic = {
  [TTopic in ClientToServerEventTopic]: Extract<
    ClientToServerEventV1,
    { topic: TTopic }
  >;
};

type ServerEventByTopic = {
  [TTopic in ServerToClientEventTopic]: Extract<
    ServerToClientEventV1,
    { topic: TTopic }
  >;
};

export interface TuttidEventStreamClient {
  connect(): Promise<void>;
  dispose(): void;
  publishIntent<TTopic extends ClientToServerEventTopic>(
    topic: TTopic,
    payload: ClientEventByTopic[TTopic]["payload"]
  ): Promise<void>;
  subscribe<TTopic extends ServerToClientEventTopic>(
    topic: TTopic,
    listener: (event: ServerEventByTopic[TTopic]) => void,
    options?: TuttidEventStreamSubscribeOptions
  ): () => void;
  subscribeConnectionState(
    listener: (state: TuttidEventStreamConnectionState) => void
  ): () => void;
}

export type TuttidEventStreamConnectionState = EventStreamConnectionState;

export interface TuttidEventStreamSubscribeOptions {
  scope?: BusinessEventScopeV1 | null;
}

const tuttiEventStreamProtocol: EventStreamProtocol<
  ClientToServerEventV1,
  BusinessEventScopeV1
> = {
  protocolVersion: businessEventProtocolVersion,
  catalogRevision: businessEventCatalogRevision,
  assertValidClientFrame(frame) {
    assertValidClientFrame(frame);
  },
  assertValidServerFrame(frame) {
    assertValidServerFrame(frame);
  },
  createClientEvent(topic, payload) {
    return {
      emittedAt: new Date().toISOString(),
      id: globalThis.crypto.randomUUID(),
      payload,
      topic,
      version: businessEventProtocolVersion
    } as ClientToServerEventV1;
  },
  normalizeScope(scope) {
    const workspaceId = scope?.workspaceId?.trim();
    if (!workspaceId) {
      return undefined;
    }
    return { workspaceId };
  },
  scopeKey(scope) {
    return scope?.workspaceId ?? "";
  },
  eventMatchesScope(eventScope, subscriptionScope) {
    const workspaceId = subscriptionScope?.workspaceId?.trim();
    if (!workspaceId) {
      return true;
    }
    return eventScope?.workspaceId?.trim() === workspaceId;
  }
};

export function createTuttidEventStreamClient(
  input: CreateTuttidEventStreamClientInput
): TuttidEventStreamClient {
  return createEventStreamClient<
    ClientToServerEventV1,
    ServerToClientEventV1,
    BusinessEventScopeV1
  >({
    defaultScope: input.defaultScope,
    heartbeat: input.heartbeat,
    protocol: tuttiEventStreamProtocol,
    reconnect: input.reconnect,
    resolveUrl: input.resolveUrl,
    webSocketFactory: input.webSocketFactory
  }) as unknown as TuttidEventStreamClient;
}
