import type { AgentActivityAdapter } from "./adapter.ts";
import { cloneAgentActivityMessage } from "./merge.ts";
import { createAgentActivityComposerOptionsController } from "./controllerComposerOptions.ts";
import { createAgentActivitySessionMessageController } from "./controllerSessionMessages.ts";
import { applyActivityUpdatedEvent } from "./controllerActivityUpdated.ts";
import {
  areAgentActivitySessionsEqual,
  areShallowObjectArraysEqual,
  canonicalizeSnapshotMessageBuckets,
  cloneAgentActivitySession,
  cloneAgentActivitySnapshot,
  createEmptyAgentActivitySnapshot,
  isSessionVersionRegression,
  removeSnapshotSession,
  upsertSnapshotSession
} from "./controllerSnapshot.ts";
import type {
  AgentActivityComposerOptions,
  AgentActivityMessageOrder,
  AgentActivityMessagePage,
  AgentActivitySnapshot,
  AgentActivityUpdatedApplyResult,
  AgentActivityUpdatedEvent
} from "./types.ts";
import {
  normalizeAgentActivitySession,
  type AgentActivitySessionInput
} from "./sessionNormalization.ts";

export {
  cloneAgentActivitySnapshot,
  createEmptyAgentActivitySnapshot,
  setAgentActivityStoreDiagnosticSink
} from "./controllerSnapshot.ts";

export interface CreateAgentActivityControllerInput {
  adapter: AgentActivityAdapter;
  autoRetainSessionEvents?: boolean;
  workspaceId: string;
}

export interface AgentActivityController {
  getSnapshot(): AgentActivitySnapshot;
  subscribe(listener: AgentActivitySnapshotListener): () => void;
  load(signal?: AbortSignal): Promise<AgentActivitySnapshot>;
  loadComposerOptions(
    input: import("./controllerComposerOptions.ts").AgentActivityLoadComposerOptionsControllerInput
  ): Promise<AgentActivityComposerOptions>;
  invalidateComposerOptions(input?: { providers?: readonly string[] }): void;
  listSessionMessages(input: {
    agentSessionId: string;
    afterVersion?: number;
    beforeVersion?: number;
    cache?: boolean;
    limit?: number;
    order?: AgentActivityMessageOrder;
    signal?: AbortSignal;
  }): Promise<AgentActivityMessagePage>;
  retainSessionEvents(input: {
    agentSessionId: string;
    afterVersion?: number;
    onError?: (error: unknown) => void;
  }): () => void;
  removeSession(agentSessionId: string): void;
  upsertSession(session: AgentActivitySessionInput): void;
  applyActivityUpdatedEvent(
    event: AgentActivityUpdatedEvent
  ): AgentActivityUpdatedApplyResult;
}

export type AgentActivitySnapshotListener = (
  snapshot: AgentActivitySnapshot
) => void;

export function createAgentActivityController({
  adapter,
  autoRetainSessionEvents = true,
  workspaceId
}: CreateAgentActivityControllerInput): AgentActivityController {
  const listeners = new Set<AgentActivitySnapshotListener>();
  let snapshot: AgentActivitySnapshot =
    createEmptyAgentActivitySnapshot(workspaceId);

  const emit = (): void => {
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const updateSnapshot = (
    updater: (current: AgentActivitySnapshot) => AgentActivitySnapshot
  ): AgentActivitySnapshot => {
    const nextSnapshot = updater(snapshot);
    if (nextSnapshot === snapshot) {
      return snapshot;
    }
    snapshot = cloneAgentActivitySnapshot(nextSnapshot);
    emit();
    return snapshot;
  };

  const composerOptions = createAgentActivityComposerOptionsController({
    adapter,
    getSnapshot: () => snapshot,
    updateSnapshot,
    workspaceId
  });
  const sessionMessages = createAgentActivitySessionMessageController({
    adapter,
    getSnapshot: () => snapshot,
    updateSnapshot,
    workspaceId
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    async load(signal) {
      const response = await adapter.listSessions({ workspaceId, signal });
      const nextSessions = response.sessions;
      const nextPresences = response.presences ?? [];
      const nextSnapshot = updateSnapshot((current) => {
        const sessionDataUnchanged =
          areShallowObjectArraysEqual(current.sessions, nextSessions) &&
          areShallowObjectArraysEqual(current.presences, nextPresences);
        const reconciledSessions = sessionDataUnchanged
          ? current.sessions
          : nextSessions.map((nextSession) => {
              const existing = current.sessions.find(
                (item) => item.agentSessionId === nextSession.agentSessionId
              );
              if (
                existing &&
                (isSessionVersionRegression("load", existing, nextSession) ||
                  areAgentActivitySessionsEqual(existing, nextSession))
              ) {
                return existing;
              }
              return nextSession;
            });
        const reconciledDataUnchanged =
          areShallowObjectArraysEqual(current.sessions, reconciledSessions) &&
          areShallowObjectArraysEqual(current.presences, nextPresences);
        const source = reconciledDataUnchanged
          ? current
          : {
              ...current,
              presences: nextPresences,
              sessions: reconciledSessions
            };
        const canonical = canonicalizeSnapshotMessageBuckets(source);
        if (canonical !== source) {
          return canonical;
        }
        return reconciledDataUnchanged ? current : source;
      });
      if (autoRetainSessionEvents) {
        sessionMessages.reconcileAutoRetained(nextSnapshot.sessions, signal);
      }
      return nextSnapshot;
    },
    loadComposerOptions: composerOptions.load,
    invalidateComposerOptions: composerOptions.invalidate,
    listSessionMessages: sessionMessages.list,
    retainSessionEvents: sessionMessages.retain,
    removeSession(agentSessionId) {
      updateSnapshot((current) =>
        removeSnapshotSession(current, agentSessionId)
      );
    },
    upsertSession(session) {
      if (session.workspaceId && session.workspaceId !== snapshot.workspaceId) {
        return;
      }
      updateSnapshot((current) =>
        upsertSnapshotSession(
          current,
          normalizeAgentActivitySession(session),
          "upsert_session"
        )
      );
    },
    applyActivityUpdatedEvent(event) {
      const result = applyActivityUpdatedEvent(snapshot, event);
      if (result.snapshot !== snapshot) {
        snapshot = result.snapshot;
        emit();
      }
      return {
        applied: result.applied,
        messages: result.messages.map(cloneAgentActivityMessage),
        session: result.session
          ? cloneAgentActivitySession(result.session)
          : null
      };
    }
  };
}
