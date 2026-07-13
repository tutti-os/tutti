import type { AgentActivityAdapter } from "./adapter.ts";
import { latestAgentActivityMessageVersion } from "./merge.ts";
import { loadAllAgentSessionMessages } from "./pagination.ts";
import {
  applySessionMessageEvent,
  mergeSnapshotMessages,
  shouldAutoRetainSessionEvents
} from "./controllerSnapshot.ts";
import type {
  AgentActivityMessageOrder,
  AgentActivityMessagePage,
  AgentActivitySession,
  AgentActivitySnapshot
} from "./types.ts";

interface RetainedSessionStream {
  abortController: AbortController;
  refCount: number;
  unsubscribe: (() => void) | null;
}

export interface AgentActivitySessionMessageController {
  list(input: {
    agentSessionId: string;
    afterVersion?: number;
    beforeVersion?: number;
    cache?: boolean;
    limit?: number;
    order?: AgentActivityMessageOrder;
    signal?: AbortSignal;
  }): Promise<AgentActivityMessagePage>;
  retain(input: {
    agentSessionId: string;
    afterVersion?: number;
    onError?: (error: unknown) => void;
  }): () => void;
  reconcileAutoRetained(
    sessions: readonly AgentActivitySession[],
    signal: AbortSignal | undefined
  ): void;
}

export function createAgentActivitySessionMessageController(input: {
  adapter: AgentActivityAdapter;
  getSnapshot: () => AgentActivitySnapshot;
  updateSnapshot: (
    updater: (current: AgentActivitySnapshot) => AgentActivitySnapshot
  ) => AgentActivitySnapshot;
  workspaceId: string;
}): AgentActivitySessionMessageController {
  const activeSyncs = new Map<string, Promise<void>>();
  const autoReleases = new Map<string, () => void>();
  const retainedStreams = new Map<string, RetainedSessionStream>();

  async function list(
    request: Parameters<AgentActivitySessionMessageController["list"]>[0]
  ): Promise<AgentActivityMessagePage> {
    const response = await input.adapter.listSessionMessages({
      workspaceId: input.workspaceId,
      agentSessionId: request.agentSessionId,
      afterVersion: request.afterVersion,
      beforeVersion: request.beforeVersion,
      limit: request.limit,
      order: request.order,
      signal: request.signal
    });
    if (request.cache !== false) {
      input.updateSnapshot((current) =>
        mergeSnapshotMessages(
          current,
          request.agentSessionId,
          response.messages
        )
      );
    }
    return {
      ...response,
      messages: response.messages.map((message) => ({
        ...message,
        payload: { ...message.payload }
      }))
    };
  }

  function retain(
    request: Parameters<AgentActivitySessionMessageController["retain"]>[0] & {
      onRetainFailed?: () => void;
    }
  ): () => void {
    const agentSessionId = request.agentSessionId.trim();
    if (!agentSessionId) return () => {};
    const subscribeSessionEvents = input.adapter.subscribeSessionEvents;
    if (!subscribeSessionEvents) return () => {};
    const existing = retainedStreams.get(agentSessionId);
    if (existing) {
      existing.refCount += 1;
      return createRelease(agentSessionId);
    }
    const abortController = new AbortController();
    const stream: RetainedSessionStream = {
      abortController,
      refCount: 1,
      unsubscribe: null
    };
    retainedStreams.set(agentSessionId, stream);
    const cached =
      input.getSnapshot().sessionMessagesById[agentSessionId] ?? [];
    const afterVersion =
      request.afterVersion ?? latestAgentActivityMessageVersion(cached);
    void subscribeSessionEvents({
      workspaceId: input.workspaceId,
      agentSessionId,
      afterVersion,
      signal: abortController.signal,
      onEvent(event) {
        if (!abortController.signal.aborted) {
          input.updateSnapshot((current) =>
            applySessionMessageEvent(current, event)
          );
        }
      },
      onError: request.onError
    })
      .then((unsubscribe) => {
        const retained = retainedStreams.get(agentSessionId);
        if (!retained || retained.abortController.signal.aborted) {
          unsubscribe();
        } else {
          retained.unsubscribe = unsubscribe;
        }
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          reportStreamFailure("subscribe_failed", agentSessionId, error);
          invokeErrorHandler(request.onError, agentSessionId, error);
        }
        if (retainedStreams.get(agentSessionId) === stream) {
          retainedStreams.delete(agentSessionId);
        }
        request.onRetainFailed?.();
        abortController.abort();
        stream.unsubscribe?.();
      });
    return createRelease(agentSessionId);
  }

  function reconcileAutoRetained(
    sessions: readonly AgentActivitySession[],
    signal: AbortSignal | undefined
  ): void {
    const activeIds = new Set(
      sessions
        .filter(shouldAutoRetainSessionEvents)
        .map((session) => session.agentSessionId.trim())
        .filter(Boolean)
    );
    for (const [agentSessionId, release] of autoReleases) {
      if (!activeIds.has(agentSessionId)) {
        release();
        autoReleases.delete(agentSessionId);
      }
    }
    for (const agentSessionId of activeIds) {
      if (!autoReleases.has(agentSessionId)) {
        autoReleases.set(
          agentSessionId,
          retain({
            agentSessionId,
            onRetainFailed: () => autoReleases.delete(agentSessionId)
          })
        );
      }
      sync(agentSessionId, signal);
    }
  }

  function sync(agentSessionId: string, signal: AbortSignal | undefined): void {
    if (activeSyncs.has(agentSessionId)) return;
    const cached =
      input.getSnapshot().sessionMessagesById[agentSessionId] ?? [];
    const afterVersion = latestAgentActivityMessageVersion(cached);
    const pending = loadAllAgentSessionMessages({
      afterVersion,
      shouldAbort: () => signal?.aborted ?? false,
      listPage: (cursor) =>
        input.adapter.listSessionMessages({
          workspaceId: input.workspaceId,
          agentSessionId,
          afterVersion: cursor,
          signal
        }),
      onPage: (messages) =>
        input.updateSnapshot((current) =>
          mergeSnapshotMessages(current, agentSessionId, messages)
        )
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!signal?.aborted) {
          reportStreamFailure("message_sync_failed", agentSessionId, error);
        }
      })
      .finally(() => {
        if (activeSyncs.get(agentSessionId) === pending) {
          activeSyncs.delete(agentSessionId);
        }
      });
    activeSyncs.set(agentSessionId, pending);
  }

  function createRelease(agentSessionId: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const stream = retainedStreams.get(agentSessionId);
      if (!stream) return;
      stream.refCount -= 1;
      if (stream.refCount > 0) return;
      retainedStreams.delete(agentSessionId);
      stream.abortController.abort();
      stream.unsubscribe?.();
    };
  }

  function reportStreamFailure(
    event: string,
    agentSessionId: string,
    error: unknown
  ): void {
    console.error(
      "[agent-activity-session-messages]",
      JSON.stringify({
        event,
        agentSessionId,
        error: error instanceof Error ? error.message : String(error),
        workspaceId: input.workspaceId
      })
    );
  }

  function invokeErrorHandler(
    handler: ((error: unknown) => void) | undefined,
    agentSessionId: string,
    error: unknown
  ): void {
    if (!handler) return;
    try {
      handler(error);
    } catch (handlerError) {
      reportStreamFailure("error_handler_failed", agentSessionId, handlerError);
    }
  }

  return { list, retain, reconcileAutoRetained };
}
