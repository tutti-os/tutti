import { useCallback } from "react";
import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import { useAgentSessionPagingState } from "./useAgentSessionPagingState";
import {
  useAgentSessionTransport,
  type AgentSessionViewRef
} from "./useAgentSessionTransport";

export function useAgentSessionControllerState(
  activeRef: AgentSessionViewRef,
  canonicalMessages: readonly AgentActivityMessage[] = [],
  canonicalHasOlderMessages?: boolean
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
              hasOlderMessages: null,
              oldestLoadedVersion: null
            }),
            ...(pagingEntry ?? {
              error: null,
              isLoadingMessages: false,
              isLoadingOlderMessages: false
            }),
            hasOlderMessages: transportEntry?.hasOlderMessages ?? false
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
  const storedActiveTransport = transport.get(activeRef);
  const storedActivePaging = paging.get(activeRef);
  const canonicalOldestVersion = oldestVersion(canonicalMessages);
  const hasActiveView =
    storedActiveTransport !== null ||
    storedActivePaging !== null ||
    canonicalOldestVersion !== null ||
    canonicalHasOlderMessages !== undefined;
  const activeSessionView = hasActiveView
    ? {
        error: storedActivePaging?.error ?? null,
        hasOlderMessages:
          storedActiveTransport?.hasOlderMessages ??
          canonicalHasOlderMessages ??
          false,
        isLoadingMessages: storedActivePaging?.isLoadingMessages ?? false,
        isLoadingOlderMessages:
          storedActivePaging?.isLoadingOlderMessages ?? false,
        olderMessages: storedActiveTransport?.olderMessages ?? [],
        oldestLoadedVersion:
          storedActiveTransport?.oldestLoadedVersion === null ||
          storedActiveTransport === null
            ? canonicalOldestVersion
            : canonicalOldestVersion === null
              ? storedActiveTransport.oldestLoadedVersion
              : Math.min(
                  storedActiveTransport.oldestLoadedVersion,
                  canonicalOldestVersion
                )
      }
    : null;
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
