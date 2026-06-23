import { useEffect, useMemo, useRef } from "react";
import type { AgentHostAgentActivityStreamEvent } from "../../../../../shared/contracts/dto";
import {
  createAgentSessionViewKey,
  getAgentSessionView,
  watchAgentSession,
  type AgentSessionViewRef,
  useAgentSessionView as useStoreAgentSessionView
} from "./agentSessionViewStore";

export { getAgentSessionView };

export function useAgentSessionView(ref: AgentSessionViewRef) {
  return useStoreAgentSessionView(ref);
}

export function useWatchAgentSession(input: {
  workspaceId: string;
  agentSessionId: string | null | undefined;
  enabled?: boolean;
  onEvents?: (events: readonly AgentHostAgentActivityStreamEvent[]) => void;
  onSubscribe?: () => void;
  onCleanup?: () => void;
}) {
  const onEventsRef = useRef(input.onEvents);
  const onSubscribeRef = useRef(input.onSubscribe);
  const onCleanupRef = useRef(input.onCleanup);
  const hasBatchEventListener = input.onEvents !== undefined;

  useEffect(() => {
    onEventsRef.current = input.onEvents;
    onSubscribeRef.current = input.onSubscribe;
    onCleanupRef.current = input.onCleanup;
  }, [input.onCleanup, input.onEvents, input.onSubscribe]);

  useEffect(() => {
    const workspaceId = input.workspaceId.trim();
    const agentSessionId = input.agentSessionId?.trim();
    if (!input.enabled || !workspaceId || !agentSessionId) {
      return undefined;
    }
    onSubscribeRef.current?.();
    const unsubscribe = watchAgentSession(
      { workspaceId, agentSessionId },
      {
        ...(hasBatchEventListener
          ? {
              onEvents: (
                events: readonly AgentHostAgentActivityStreamEvent[]
              ) => {
                onEventsRef.current?.(events);
              }
            }
          : {})
      }
    );
    return () => {
      onCleanupRef.current?.();
      unsubscribe();
    };
  }, [
    hasBatchEventListener,
    input.agentSessionId,
    input.enabled,
    input.workspaceId
  ]);
}

export function useWatchAgentSessions(input: {
  workspaceId: string;
  agentSessionIds: readonly string[];
  enabled?: boolean;
  onEvents?: (events: readonly AgentHostAgentActivityStreamEvent[]) => void;
}) {
  const onEventsRef = useRef(input.onEvents);
  const hasBatchEventListener = input.onEvents !== undefined;
  const agentSessionIdsKey = JSON.stringify(
    [...new Set(input.agentSessionIds.map((id) => id.trim()))]
      .filter(Boolean)
      .sort()
  );

  useEffect(() => {
    onEventsRef.current = input.onEvents;
  }, [input.onEvents]);

  useEffect(() => {
    const workspaceId = input.workspaceId.trim();
    if (!input.enabled || !workspaceId) {
      return undefined;
    }
    const uniqueAgentSessionIds = JSON.parse(agentSessionIdsKey) as string[];
    if (uniqueAgentSessionIds.length === 0) {
      return undefined;
    }
    const unsubscribes = uniqueAgentSessionIds.map((agentSessionId) =>
      watchAgentSession(
        { workspaceId, agentSessionId },
        {
          ...(hasBatchEventListener
            ? {
                onEvents: (
                  events: readonly AgentHostAgentActivityStreamEvent[]
                ) => {
                  onEventsRef.current?.(events);
                }
              }
            : {})
        }
      )
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [
    agentSessionIdsKey,
    hasBatchEventListener,
    input.enabled,
    input.workspaceId
  ]);
}

export function useAgentSessionViewSnapshot(ref: AgentSessionViewRef) {
  const sessionView = useStoreAgentSessionView(ref);
  return useMemo(
    () => ({
      sessionView,
      hasSessionView:
        Boolean(createAgentSessionViewKey(ref)) && Boolean(sessionView)
    }),
    [ref, sessionView]
  );
}
