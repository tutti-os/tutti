import { useCallback, useRef, useState } from "react";
import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import { mergeWorkspaceAgentMessages } from "../../../../../host/workspaceAgentSessionMessages";

export interface AgentSessionViewRef {
  workspaceId: string | null | undefined;
  agentSessionId: string | null | undefined;
  origin?: string | null;
}

export interface AgentSessionTransportEntry {
  olderMessages: AgentActivityMessage[];
  hasOlderMessages: boolean;
  oldestLoadedVersion: number | null;
}

const EMPTY_ENTRY: AgentSessionTransportEntry = {
  olderMessages: [],
  hasOlderMessages: false,
  oldestLoadedVersion: null
};

export function useAgentSessionTransport() {
  const [entries, setEntries] = useState<
    Record<string, AgentSessionTransportEntry>
  >({});
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const update = useCallback(
    (
      ref: AgentSessionViewRef,
      updater: (entry: AgentSessionTransportEntry) => AgentSessionTransportEntry
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
  const mergeOlder = useCallback(
    (
      ref: AgentSessionViewRef,
      messages: readonly AgentActivityMessage[],
      options: {
        hasOlderMessages?: boolean;
        oldestLoadedVersion?: number | null;
      } = {}
    ) =>
      update(ref, (entry) => {
        const olderMessages = mergeWorkspaceAgentMessages(
          entry.olderMessages,
          messages
        );
        return {
          ...entry,
          olderMessages,
          hasOlderMessages: options.hasOlderMessages ?? entry.hasOlderMessages,
          oldestLoadedVersion:
            options.oldestLoadedVersion ?? oldestVersion(olderMessages)
        };
      }),
    [update]
  );
  const resetOlder = useCallback(
    (ref: AgentSessionViewRef) =>
      update(ref, (entry) => ({
        ...entry,
        olderMessages: [],
        hasOlderMessages: false,
        oldestLoadedVersion: null
      })),
    [update]
  );
  return {
    entries,
    get,
    mergeOlder,
    remove,
    resetOlder
  };
}

function sessionKey(ref: AgentSessionViewRef): string | null {
  const workspaceId = ref.workspaceId?.trim() ?? "";
  const origin = ref.origin?.trim() ?? "";
  const agentSessionId = ref.agentSessionId?.trim() ?? "";
  return workspaceId && origin && agentSessionId
    ? `${workspaceId}::${origin}::${agentSessionId}`
    : null;
}

function oldestVersion(messages: readonly AgentActivityMessage[]) {
  const versions = messages.map((item) => item.version).filter(Number.isFinite);
  return versions.length > 0 ? Math.min(...versions) : null;
}
