import {
  createAgentGUIConversationActivityActivation,
  reconcileAgentGUIConversationActivityActivation,
  type AgentGUIConversationActivityActivation
} from "../model/agentGuiConversationActivityView";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationTypes";

const EMPTY_DELETED_SESSION_IDS: Readonly<Record<string, true>> = {};

export interface AgentGUIConversationActivityControllerInput {
  available: boolean;
  conversations: readonly AgentGUIConversationSummary[];
  deletedSessionIds?: Readonly<Record<string, true>>;
  identityKey: string;
  scopeKey: string;
}

export interface AgentGUIConversationActivityControllerSnapshot {
  available: boolean;
  activation: AgentGUIConversationActivityActivation | null;
  conversationCache: ReadonlyMap<string, AgentGUIConversationSummary>;
  enabled: boolean;
  identityKey: string | null;
  scopeKey: string | null;
}

export interface AgentGUIConversationActivityController {
  getSnapshot: () => AgentGUIConversationActivityControllerSnapshot;
  subscribe: (listener: () => void) => () => void;
  configure: (input: AgentGUIConversationActivityControllerInput) => void;
  toggle: () => void;
}

const DISABLED_SNAPSHOT: AgentGUIConversationActivityControllerSnapshot = {
  available: false,
  activation: null,
  conversationCache: new Map(),
  enabled: false,
  identityKey: null,
  scopeKey: null
};
const AVAILABLE_OFF_SNAPSHOT: AgentGUIConversationActivityControllerSnapshot = {
  ...DISABLED_SNAPSHOT,
  available: true
};

export function createAgentGUIConversationActivityController(): AgentGUIConversationActivityController {
  let snapshot = DISABLED_SNAPSHOT;
  let latestInput: AgentGUIConversationActivityControllerInput | null = null;
  const listeners = new Set<() => void>();

  const publish = (
    next: AgentGUIConversationActivityControllerSnapshot
  ): void => {
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const configure = (
    input: AgentGUIConversationActivityControllerInput
  ): void => {
    latestInput = input;
    if (!input.available) {
      if (snapshot !== DISABLED_SNAPSHOT) publish(DISABLED_SNAPSHOT);
      return;
    }
    if (!snapshot.enabled) {
      if (snapshot !== AVAILABLE_OFF_SNAPSHOT) {
        publish(AVAILABLE_OFF_SNAPSHOT);
      }
      return;
    }

    const sameContext =
      snapshot.identityKey === input.identityKey &&
      snapshot.scopeKey === input.scopeKey;
    const deletedSessionIds =
      input.deletedSessionIds ?? EMPTY_DELETED_SESSION_IDS;
    const candidates = input.conversations.filter(
      (conversation) => !deletedSessionIds[conversation.id]
    );
    const activation =
      sameContext && snapshot.activation
        ? reconcileAgentGUIConversationActivityActivation(
            snapshot.activation,
            candidates,
            deletedSessionIds
          )
        : createAgentGUIConversationActivityActivation(candidates, Date.now());
    const conversationCache = mergeConversationCache(
      sameContext ? snapshot.conversationCache : new Map(),
      candidates,
      deletedSessionIds
    );
    if (
      sameContext &&
      activation === snapshot.activation &&
      conversationCache === snapshot.conversationCache
    ) {
      return;
    }
    publish({
      available: true,
      activation,
      conversationCache,
      enabled: true,
      identityKey: input.identityKey,
      scopeKey: input.scopeKey
    });
  };

  const toggle = (): void => {
    const input = latestInput;
    if (!input) return;
    if (!input.available) return;
    if (snapshot.enabled) {
      publish(AVAILABLE_OFF_SNAPSHOT);
      return;
    }
    const deletedSessionIds =
      input.deletedSessionIds ?? EMPTY_DELETED_SESSION_IDS;
    const candidates = input.conversations.filter(
      (conversation) => !deletedSessionIds[conversation.id]
    );
    publish({
      available: true,
      activation: createAgentGUIConversationActivityActivation(
        candidates,
        Date.now()
      ),
      conversationCache: mergeConversationCache(
        new Map(),
        candidates,
        deletedSessionIds
      ),
      enabled: true,
      identityKey: input.identityKey,
      scopeKey: input.scopeKey
    });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    configure,
    toggle
  };
}

function mergeConversationCache(
  previous: ReadonlyMap<string, AgentGUIConversationSummary>,
  conversations: readonly AgentGUIConversationSummary[],
  deletedSessionIds: Readonly<Record<string, true>>
): ReadonlyMap<string, AgentGUIConversationSummary> {
  const next = new Map(previous);
  for (const deletedId of Object.keys(deletedSessionIds)) {
    next.delete(deletedId);
  }
  for (const conversation of conversations) {
    next.set(conversation.id, conversation);
  }
  if (conversationMapsEqual(previous, next)) return previous;
  return next;
}

function conversationMapsEqual(
  left: ReadonlyMap<string, AgentGUIConversationSummary>,
  right: ReadonlyMap<string, AgentGUIConversationSummary>
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([id, conversation]) => right.get(id) === conversation)
  );
}
