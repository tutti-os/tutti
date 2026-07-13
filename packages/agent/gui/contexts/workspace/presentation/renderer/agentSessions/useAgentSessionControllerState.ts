import { useCallback } from "react";
import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import { useAgentSessionPagingState } from "./useAgentSessionPagingState";
import {
  useAgentSessionTransport,
  type AgentSessionViewRef
} from "./useAgentSessionTransport";

export function useAgentSessionControllerState(
  activeRef: AgentSessionViewRef,
  canonicalMessages: readonly AgentActivityMessage[] = []
) {
  const transport = useAgentSessionTransport();
  const paging = useAgentSessionPagingState();
  const getAgentSessionView = useCallback(
    (ref: AgentSessionViewRef) => {
      const transportEntry = transport.get(ref);
      const pagingEntry = paging.get(ref);
      return transportEntry || pagingEntry
        ? {
            ...(transportEntry ?? {
              olderMessages: [],
              hasOlderMessages: false,
              oldestLoadedVersion: null
            }),
            ...(pagingEntry ?? {
              error: null,
              isLoadingMessages: false,
              isLoadingOlderMessages: false
            })
          }
        : null;
    },
    [paging.get, transport.get]
  );
  const deleteAgentSessionView = useCallback(
    (ref: AgentSessionViewRef) => {
      transport.remove(ref);
      paging.remove(ref);
    },
    [paging.remove, transport.remove]
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
  void transport.entries;
  void paging.entries;
  const storedActiveView = getAgentSessionView(activeRef);
  const canonicalOldestVersion = oldestVersion(canonicalMessages);
  const activeSessionView = storedActiveView
    ? {
        ...storedActiveView,
        hasOlderMessages:
          storedActiveView.hasOlderMessages ||
          (canonicalOldestVersion !== null && canonicalOldestVersion > 1),
        oldestLoadedVersion:
          storedActiveView.oldestLoadedVersion === null
            ? canonicalOldestVersion
            : canonicalOldestVersion === null
              ? storedActiveView.oldestLoadedVersion
              : Math.min(
                  storedActiveView.oldestLoadedVersion,
                  canonicalOldestVersion
                )
      }
    : canonicalOldestVersion === null
      ? null
      : {
          error: null,
          hasOlderMessages: canonicalOldestVersion > 1,
          isLoadingMessages: false,
          isLoadingOlderMessages: false,
          olderMessages: [],
          oldestLoadedVersion: canonicalOldestVersion
        };
  return {
    activeSessionView,
    deleteAgentSessionView,
    getAgentSessionView,
    mergeAgentSessionViewOlderMessages: transport.mergeOlder,
    resetAgentSessionViewOlderMessages: transport.resetOlder,
    setAgentSessionViewError: paging.setError,
    setAgentSessionViewMessagesLoading,
    setAgentSessionViewOlderMessagesLoading
  };
}

function oldestVersion(messages: readonly AgentActivityMessage[]) {
  const versions = messages.map((item) => item.version).filter(Number.isFinite);
  return versions.length > 0 ? Math.min(...versions) : null;
}
