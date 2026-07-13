import { useCallback, useRef } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import { isWorkspaceAgentActivityOptimisticMessage } from "../../../shared/workspaceAgentMessageOverlay";
import type { AgentSessionViewRef } from "../../../contexts/workspace/presentation/renderer/agentSessions/useAgentSessionTransport";

const PAGE_SIZE = 100;

export function minFiniteMessageVersion(
  messages: readonly AgentActivityMessage[]
): number | null {
  let result: number | null = null;
  for (const message of messages) {
    if (
      !Number.isFinite(message.version) ||
      isWorkspaceAgentActivityOptimisticMessage(message)
    )
      continue;
    result =
      result === null ? message.version : Math.min(result, message.version);
  }
  return result;
}

export function maxFiniteMessageVersion(
  messages: readonly AgentActivityMessage[]
): number | null {
  let result: number | null = null;
  for (const message of messages) {
    if (
      !Number.isFinite(message.version) ||
      isWorkspaceAgentActivityOptimisticMessage(message)
    )
      continue;
    result =
      result === null ? message.version : Math.max(result, message.version);
  }
  return result;
}

function messageText(message: AgentActivityMessage): string {
  const payload = message.payload;
  for (const key of ["displayPrompt", "text"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const content = payload.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block))
        return "";
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isUserTextMessage(message: AgentActivityMessage): boolean {
  return (
    message.kind.trim().toLowerCase() === "text" &&
    message.role.trim().toLowerCase() === "user" &&
    messageText(message).trim() !== ""
  );
}

export function windowHasTurnMissingUserPrompt(
  messages: readonly AgentActivityMessage[],
  newestPagedVersion: number | null
): boolean {
  if (newestPagedVersion === null) {
    return messages.length > 0 && !messages.some(isUserTextMessage);
  }
  const turnIdsWithUserPrompt = new Set<string>();
  const pagedTurnIds = new Set<string>();
  for (const message of messages) {
    if (isWorkspaceAgentActivityOptimisticMessage(message)) continue;
    const turnId = message.turnId?.trim() ?? "";
    if (!turnId) continue;
    if (
      Number.isFinite(message.version) &&
      message.version <= newestPagedVersion
    ) {
      pagedTurnIds.add(turnId);
    }
    if (isUserTextMessage(message)) turnIdsWithUserPrompt.add(turnId);
  }
  return [...pagedTurnIds].some((turnId) => !turnIdsWithUserPrompt.has(turnId));
}

export function filterMessagesForOptimisticDetailWindow(input: {
  detailMessages: readonly AgentActivityMessage[];
  localMessages: readonly AgentActivityMessage[];
}): AgentActivityMessage[] {
  const optimisticTurnIds = new Set(
    input.detailMessages
      .filter(isWorkspaceAgentActivityOptimisticMessage)
      .map((message) => message.turnId?.trim() ?? "")
      .filter(Boolean)
  );
  if (optimisticTurnIds.size === 0) return [];
  return input.localMessages.filter((message) => {
    if (isWorkspaceAgentActivityOptimisticMessage(message)) return true;
    const turnId = message.turnId?.trim() ?? "";
    return turnId !== "" && optimisticTurnIds.has(turnId);
  });
}

export function filterMessagesForDetailWindowOverlay(input: {
  detailMessages: readonly AgentActivityMessage[];
  durableMessages: readonly AgentActivityMessage[];
  localMessages: readonly AgentActivityMessage[];
}): AgentActivityMessage[] {
  if (input.localMessages.length === 0) return [];
  if (input.detailMessages.length === 0) {
    if (input.durableMessages.length <= PAGE_SIZE)
      return [...input.localMessages];
    const newest = maxFiniteMessageVersion(input.durableMessages);
    return input.localMessages.filter(
      (message) =>
        isWorkspaceAgentActivityOptimisticMessage(message) ||
        (newest !== null &&
          Number.isFinite(message.version) &&
          message.version >= newest)
    );
  }
  const bounded = input.detailMessages.filter(
    (message) => !isWorkspaceAgentActivityOptimisticMessage(message)
  );
  const oldest = minFiniteMessageVersion(bounded);
  const newest = maxFiniteMessageVersion(bounded);
  if (oldest === null && newest === null) {
    const optimistic = filterMessagesForOptimisticDetailWindow(input);
    return optimistic.length > 0 ||
      input.detailMessages.some(isWorkspaceAgentActivityOptimisticMessage)
      ? optimistic
      : [...input.localMessages];
  }
  return input.localMessages.filter(
    (message) =>
      isWorkspaceAgentActivityOptimisticMessage(message) ||
      !Number.isFinite(message.version) ||
      (newest !== null && message.version > newest) ||
      (oldest !== null && message.version >= oldest)
  );
}

export function sessionViewHasUnhydratedOlderDetailMessages(input: {
  agentSessionId: string;
  detailMessages: readonly AgentActivityMessage[];
  hasLoadedInitialMessages: boolean;
  hasOlderMessages: boolean;
  oldestLoadedVersion: number | null;
  snapshotMessagesById: Record<string, AgentActivityMessage[]>;
}): boolean {
  if (
    input.hasLoadedInitialMessages ||
    input.hasOlderMessages ||
    input.detailMessages.length === 0
  )
    return false;
  const oldest =
    input.oldestLoadedVersion ?? minFiniteMessageVersion(input.detailMessages);
  if (oldest === null) return false;
  const snapshotOldest = minFiniteMessageVersion(
    input.snapshotMessagesById[input.agentSessionId] ?? []
  );
  return oldest > 1 || (snapshotOldest !== null && snapshotOldest < oldest);
}

export function sessionHasRenderableMessages(input: {
  agentSessionId: string;
  snapshotMessagesById: Record<string, AgentActivityMessage[]>;
}): boolean {
  const normalized = input.agentSessionId.trim();
  if (!normalized) return false;
  return (input.snapshotMessagesById[normalized]?.length ?? 0) > 0;
}

interface MessagePageView {
  olderMessages: AgentActivityMessage[];
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  oldestLoadedVersion: number | null;
}

export interface ConversationMessagePagingViewPort {
  get(ref: AgentSessionViewRef): MessagePageView | null;
  mergeOlder(
    ref: AgentSessionViewRef,
    messages: readonly AgentActivityMessage[],
    options?: { hasOlderMessages?: boolean }
  ): void;
  setOlderMessagesLoading(ref: AgentSessionViewRef, loading: boolean): void;
}

export interface ConversationMessagePagingProjectionPort {
  maxVersion(messages: readonly AgentActivityMessage[]): number | null;
  minVersion(messages: readonly AgentActivityMessage[]): number | null;
  windowHasTurnMissingUserPrompt(
    messages: readonly AgentActivityMessage[],
    latestVersion: number | null
  ): boolean;
}

export interface ConversationMessagePagingDiagnosticsPort {
  error(input: {
    agentSessionId: string;
    context?: Record<string, unknown>;
    error: unknown;
    phase: "load_session_messages";
  }): void;
  page(input: {
    agentSessionId: string;
    details: Record<string, unknown>;
    event: string;
    level?: "debug" | "warn";
    messages?: readonly AgentActivityMessage[];
  }): void;
}

export interface AgentConversationMessagePagingInput {
  diagnostics: ConversationMessagePagingDiagnosticsPort;
  getActiveSessionId(): string | null;
  getCanonicalMessages(agentSessionId: string): readonly AgentActivityMessage[];
  isMounted(): boolean;
  projection: ConversationMessagePagingProjectionPort;
  reload: {
    getActivationStatus(agentSessionId: string): string | null;
    loadSessionState(agentSessionId: string): void;
    refreshMessages(agentSessionId: string): void;
    syncConversationList(agentSessionId: string): void;
  };
  runtime: AgentActivityRuntime;
  sessionViewRef(agentSessionId: string): AgentSessionViewRef;
  view: ConversationMessagePagingViewPort;
  workspaceId: string;
}

export function useAgentConversationMessagePaging(
  input: AgentConversationMessagePagingInput
) {
  const inputRef = useRef(input);
  inputRef.current = input;
  const olderLoadSequenceRef = useRef(0);
  const failedOlderCursorBySessionIdRef = useRef(new Map<string, number>());

  const loadInitialMessages = useCallback(async (agentSessionId: string) => {
    const normalized = agentSessionId.trim();
    if (!normalized) return;
    const current = inputRef.current;
    current.reload.refreshMessages(normalized);
    current.reload.loadSessionState(normalized);
  }, []);

  const loadOlderMessages = useCallback(
    async (agentSessionId?: string | null) => {
      const current = inputRef.current;
      const normalized = (
        agentSessionId ??
        current.getActiveSessionId() ??
        ""
      ).trim();
      if (!normalized) return;
      const ref = current.sessionViewRef(normalized);
      const view = current.view.get(ref);
      const canonicalOldestVersion = current.projection.minVersion(
        current.getCanonicalMessages(normalized)
      );
      const oldestLoadedVersion =
        view?.oldestLoadedVersion ?? canonicalOldestVersion;
      const hasOlderMessages =
        view?.hasOlderMessages === true ||
        (canonicalOldestVersion !== null && canonicalOldestVersion > 1);
      if (
        !hasOlderMessages ||
        view?.isLoadingOlderMessages === true ||
        oldestLoadedVersion === null ||
        current.getActiveSessionId() !== normalized
      ) {
        current.diagnostics.page({
          agentSessionId: normalized,
          details: {
            activeConversationId: current.getActiveSessionId(),
            hasOlderMessages,
            isLoadingOlderMessages: view?.isLoadingOlderMessages ?? null,
            oldestLoadedVersion
          },
          event: "agent.gui.messages.older.skipped",
          level: "debug"
        });
        return;
      }
      const beforeVersion = oldestLoadedVersion;
      if (
        failedOlderCursorBySessionIdRef.current.get(normalized) ===
        beforeVersion
      ) {
        current.diagnostics.page({
          agentSessionId: normalized,
          details: { beforeVersion, reason: "previous_cursor_error" },
          event: "agent.gui.messages.older.suppressed_after_error",
          level: "warn"
        });
        return;
      }
      const requestId = ++olderLoadSequenceRef.current;
      current.view.setOlderMessagesLoading(ref, true);
      try {
        current.diagnostics.page({
          agentSessionId: normalized,
          details: {
            beforeVersion,
            limit: PAGE_SIZE,
            order: "desc",
            requestId
          },
          event: "agent.gui.messages.older.requested"
        });
        const page = await current.runtime.listSessionMessages({
          workspaceId: current.workspaceId,
          agentSessionId: normalized,
          beforeVersion,
          cache: false,
          limit: PAGE_SIZE,
          order: "desc"
        });
        if (
          !current.isMounted() ||
          current.getActiveSessionId() !== normalized ||
          olderLoadSequenceRef.current !== requestId
        ) {
          current.view.setOlderMessagesLoading(ref, false);
          return;
        }
        current.diagnostics.page({
          agentSessionId: normalized,
          details: {
            beforeVersion,
            hasMore: page.hasMore,
            latestVersion: page.latestVersion,
            requestId
          },
          event: "agent.gui.messages.older.resolved",
          messages: page.messages
        });
        failedOlderCursorBySessionIdRef.current.delete(normalized);
        current.view.mergeOlder(ref, page.messages, {
          hasOlderMessages: page.hasMore && page.messages.length > 0
        });
      } catch (error) {
        if (
          !current.isMounted() ||
          current.getActiveSessionId() !== normalized ||
          olderLoadSequenceRef.current !== requestId
        ) {
          current.view.setOlderMessagesLoading(ref, false);
          return;
        }
        failedOlderCursorBySessionIdRef.current.set(normalized, beforeVersion);
        current.diagnostics.error({
          agentSessionId: normalized,
          context: { beforeVersion, requestId },
          error,
          phase: "load_session_messages"
        });
        current.view.setOlderMessagesLoading(ref, false);
      }
    },
    []
  );

  const reloadSelectedConversation = useCallback(
    (
      agentSessionId: string,
      options: { reloadConversations: boolean; reloadDetail: boolean }
    ) => {
      if (!agentSessionId) return;
      const current = inputRef.current;
      const activationStatus =
        current.reload.getActivationStatus(agentSessionId);
      if (
        activationStatus === "failed" ||
        activationStatus === "requested" ||
        activationStatus === "uncertain"
      )
        return;
      if (options.reloadConversations) {
        current.reload.syncConversationList(agentSessionId);
      }
      if (!options.reloadDetail) return;
      void loadInitialMessages(agentSessionId.trim());
    },
    [loadInitialMessages]
  );

  return { loadInitialMessages, loadOlderMessages, reloadSelectedConversation };
}
