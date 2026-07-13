import { useCallback, useRef, useState } from "react";
import type { AgentSessionViewRef } from "./useAgentSessionTransport";

export interface AgentSessionPagingEntry {
  error: string | null;
  isLoadingMessages: boolean;
  isLoadingOlderMessages: boolean;
}

const EMPTY_ENTRY: AgentSessionPagingEntry = {
  error: null,
  isLoadingMessages: false,
  isLoadingOlderMessages: false
};

export function useAgentSessionPagingState() {
  const [entries, setEntries] = useState<
    Record<string, AgentSessionPagingEntry>
  >({});
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const update = useCallback(
    (
      ref: AgentSessionViewRef,
      updater: (entry: AgentSessionPagingEntry) => AgentSessionPagingEntry
    ) => {
      const key = sessionKey(ref);
      if (!key) return;
      setEntries((current) => {
        const previous = current[key] ?? EMPTY_ENTRY;
        const next = updater(previous);
        return next === previous ? current : { ...current, [key]: next };
      });
    },
    []
  );
  const get = useCallback((ref: AgentSessionViewRef) => {
    const key = sessionKey(ref);
    return key ? (entriesRef.current[key] ?? null) : null;
  }, []);
  const remove = useCallback((ref: AgentSessionViewRef) => {
    const key = sessionKey(ref);
    if (!key) return;
    setEntries((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);
  const flag = useCallback(
    (
      field: "isLoadingMessages" | "isLoadingOlderMessages",
      ref: AgentSessionViewRef,
      value: boolean
    ) => update(ref, (entry) => ({ ...entry, [field]: value })),
    [update]
  );
  const setError = useCallback(
    (ref: AgentSessionViewRef, error: string | null) =>
      update(ref, (entry) => ({ ...entry, error })),
    [update]
  );
  return { entries, flag, get, remove, setError };
}

function sessionKey(ref: AgentSessionViewRef): string | null {
  const workspaceId = ref.workspaceId?.trim() ?? "";
  const origin = ref.origin?.trim() ?? "";
  const agentSessionId = ref.agentSessionId?.trim() ?? "";
  return workspaceId && origin && agentSessionId
    ? `${workspaceId}::${origin}::${agentSessionId}`
    : null;
}
