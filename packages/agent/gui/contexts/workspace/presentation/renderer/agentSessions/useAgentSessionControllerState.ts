import { useCallback } from "react";
import type {
  AgentActivityMessage,
  AgentActivitySessionMessageWindow
} from "@tutti-os/agent-activity-core";
import { type AgentSessionViewRef } from "./useAgentSessionPagingState";
import { useAgentSessionPagingState } from "./useAgentSessionPagingState";

export function useAgentSessionControllerState(
  activeRef: AgentSessionViewRef,
  canonicalMessages: readonly AgentActivityMessage[] = [],
  canonicalWindow: AgentActivitySessionMessageWindow | null = null
) {
  const paging = useAgentSessionPagingState();
  const getAgentSessionView = useCallback(
    (ref: AgentSessionViewRef) => {
      const pagingEntry = paging.get(ref);
      return pagingEntry
        ? {
            ...pagingEntry,
            hasOlderMessages: false,
            oldestLoadedVersion: null
          }
        : null;
    },
    [paging.get]
  );
  const deleteAgentSessionView = useCallback(
    (ref: AgentSessionViewRef) => paging.remove(ref),
    [paging.remove]
  );
  const setAgentSessionViewMessagesLoading = useCallback(
    (ref: AgentSessionViewRef, value: boolean) =>
      paging.flag("isLoadingMessages", ref, value),
    [paging.flag]
  );
  const setAgentSessionViewOlderMessagesLoading = useCallback(
    (ref: AgentSessionViewRef, value: boolean) =>
      paging.flag("isLoadingOlderMessages", ref, value),
    [paging.flag]
  );
  void paging.entries;
  const storedActiveView = getAgentSessionView(activeRef);
  const canonicalOldestVersion =
    canonicalWindow?.oldestLoadedVersion ?? oldestVersion(canonicalMessages);
  const activeSessionView =
    storedActiveView === null && canonicalOldestVersion === null
      ? null
      : {
          ...(storedActiveView ?? {
            error: null,
            isLoadingMessages: false,
            isLoadingOlderMessages: false
          }),
          hasOlderMessages: canonicalWindow?.hasOlderMessages ?? false,
          oldestLoadedVersion: canonicalOldestVersion
        };
  return {
    activeSessionView,
    deleteAgentSessionView,
    getAgentSessionView,
    setAgentSessionViewError: paging.setError,
    setAgentSessionViewMessagesLoading,
    setAgentSessionViewOlderMessagesLoading
  };
}

function oldestVersion(messages: readonly AgentActivityMessage[]) {
  const versions = messages.map((item) => item.version).filter(Number.isFinite);
  return versions.length > 0 ? Math.min(...versions) : null;
}
