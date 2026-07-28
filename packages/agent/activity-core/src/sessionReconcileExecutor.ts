import type { AgentActivityAdapter } from "./adapter.ts";
import { createAgentActivitySnapshotProjector } from "./engine/agentActivitySnapshot.projector.ts";
import type {
  AgentActivitySessionDetailSnapshot,
  SessionReconcileCommand
} from "./engine/sessionReconcile.types.ts";
import type { AgentSessionEngine } from "./engine/types.ts";
import { mergeAgentActivityMessages } from "./merge.ts";
import { agentActivitySessionMessageWindowFromDescendingPage } from "./pagination.ts";
import type {
  AgentActivityDurableMessage,
  AgentActivityMessage,
  AgentActivityMessagePage,
  AgentActivitySession
} from "./types.ts";

const MESSAGE_PAGE_SIZE = 100;
const MAX_MESSAGE_PAGES = 1_000;

export type AgentActivityChildMessageHydration =
  | "requested_session"
  | "session_hierarchy";

export interface AgentActivitySessionReconcilePort {
  getSessionDetail(input: {
    agentSessionId: string;
    signal?: AbortSignal;
    workspaceId: string;
  }): Promise<AgentActivitySessionDetailSnapshot>;
  listSessionMessages: AgentActivityAdapter["listSessionMessages"];
}

export type AgentActivitySessionReconcileResult =
  | {
      affectedSessionIds: readonly string[];
      appliedMessages: readonly AgentActivityDurableMessage[];
      session: AgentActivitySession | null;
      status: "applied";
    }
  | {
      reason: "session_deleted";
      status: "skipped";
    };

export interface AgentActivitySessionReconcileExecutor {
  execute(
    command: SessionReconcileCommand,
    options?: { signal?: AbortSignal }
  ): Promise<AgentActivitySessionReconcileResult>;
}

export type AgentActivitySessionReconcileTrace =
  | {
      agentSessionId: string;
      detail?: AgentActivitySessionDetailSnapshot;
      phase: "discovery" | "final" | "state";
      status: "requested" | "resolved";
      type: "detail";
    }
  | {
      afterVersion: number;
      agentSessionId: string;
      latestVersion?: number;
      messageCount?: number;
      messageVersion: number;
      requestedAgentSessionId: string;
      scope: "combined" | "messages";
      status: "requested" | "resolved" | "skipped";
      type: "messages";
    }
  | {
      detail: AgentActivitySessionDetailSnapshot;
      scope: "state" | "state_and_messages";
      status: "applied" | "applying";
      type: "detailApply";
    };

export interface CreateAgentActivitySessionReconcileExecutorInput {
  childMessageHydration: AgentActivityChildMessageHydration;
  engine: Pick<AgentSessionEngine, "dispatch" | "getSnapshot">;
  isAvailable?(): boolean;
  isSessionDeleted(agentSessionId: string): boolean;
  onTrace?(event: AgentActivitySessionReconcileTrace): void;
  port: AgentActivitySessionReconcilePort;
  reconcileOptimisticMessages(agentSessionId: string): void;
  workspaceId: string;
}

interface ReconciledMessagePage {
  agentSessionId: string;
  page: AgentActivityMessagePage;
  startsAtNewestBoundary: boolean;
}

type ReconcileSessionIdentity = Pick<
  AgentActivitySession,
  "agentSessionId" | "kind" | "messageVersion"
>;

export function createAgentActivitySessionReconcileExecutor(
  input: CreateAgentActivitySessionReconcileExecutorInput
): AgentActivitySessionReconcileExecutor {
  const workspaceId = normalizeRequiredIdentity(
    input.workspaceId,
    "workspaceId"
  );
  const projectSnapshot = createAgentActivitySnapshotProjector(workspaceId);

  const readSnapshot = () => projectSnapshot(input.engine.getSnapshot());
  const shouldSkip = (agentSessionId: string, signal?: AbortSignal) =>
    input.isSessionDeleted(agentSessionId) || signal?.aborted === true;
  const skippedResult = (): Extract<
    AgentActivitySessionReconcileResult,
    { status: "skipped" }
  > => ({
    reason: "session_deleted",
    status: "skipped"
  });
  const throwIfAborted = (signal?: AbortSignal) => {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("session reconcile aborted");
    }
  };
  const throwIfUnavailable = () => {
    if (input.isAvailable?.() === false) {
      throw new Error("session reconcile host is unavailable");
    }
  };
  const assertExecutionActive = (signal?: AbortSignal) => {
    throwIfAborted(signal);
    throwIfUnavailable();
  };

  const getDetail = async (
    agentSessionId: string,
    phase: "discovery" | "final" | "state",
    signal?: AbortSignal
  ): Promise<AgentActivitySessionDetailSnapshot> => {
    assertExecutionActive(signal);
    input.onTrace?.({
      agentSessionId,
      phase,
      status: "requested",
      type: "detail"
    });
    const detail = await input.port.getSessionDetail({
      agentSessionId,
      signal,
      workspaceId
    });
    assertExecutionActive(signal);
    if (detail.session.agentSessionId !== agentSessionId) {
      throw new Error(
        `session reconcile detail identity mismatch: expected ${agentSessionId}, received ${detail.session.agentSessionId}`
      );
    }
    input.onTrace?.({
      agentSessionId,
      detail,
      phase,
      status: "resolved",
      type: "detail"
    });
    return detail;
  };

  const reconcilePage = async (
    session: ReconcileSessionIdentity,
    cached: readonly AgentActivityMessage[],
    messageWindowKnown: boolean,
    requestedAgentSessionId: string,
    scope: "combined" | "messages",
    signal?: AbortSignal
  ): Promise<ReconciledMessagePage | null> => {
    const agentSessionId = session.agentSessionId;
    assertExecutionActive(signal);
    if (shouldSkip(agentSessionId, signal)) return null;
    const childSession = session.kind === "child";
    const afterVersion = childSession
      ? latestDurableMessageVersion(cached)
      : conversationReconcileAfterVersion(cached);
    if (
      scope === "combined" &&
      childSession &&
      messageWindowKnown &&
      afterVersion >= session.messageVersion
    ) {
      input.onTrace?.({
        afterVersion,
        agentSessionId,
        messageVersion: session.messageVersion,
        requestedAgentSessionId,
        scope,
        status: "skipped",
        type: "messages"
      });
      return null;
    }
    input.onTrace?.({
      afterVersion,
      agentSessionId,
      messageVersion: session.messageVersion,
      requestedAgentSessionId,
      scope,
      status: "requested",
      type: "messages"
    });
    const startsAtNewestBoundary = !messageWindowKnown;
    const shouldLoadNewestPage =
      startsAtNewestBoundary || (!childSession && cached.length === 0);
    if (shouldLoadNewestPage) {
      const page = await input.port.listSessionMessages({
        agentSessionId,
        limit: MESSAGE_PAGE_SIZE,
        order: "desc",
        signal,
        workspaceId
      });
      assertExecutionActive(signal);
      assertMessagePageIdentity(page, workspaceId, agentSessionId);
      if (shouldSkip(agentSessionId, signal)) return null;
      input.onTrace?.({
        afterVersion,
        agentSessionId,
        latestVersion: page.latestVersion,
        messageCount: page.messages.length,
        messageVersion: session.messageVersion,
        requestedAgentSessionId,
        scope,
        status: "resolved",
        type: "messages"
      });
      return { agentSessionId, page, startsAtNewestBoundary };
    }

    let cursor = afterVersion;
    const messages: AgentActivityDurableMessage[] = [];
    for (let pageIndex = 0; pageIndex < MAX_MESSAGE_PAGES; pageIndex += 1) {
      const page = await input.port.listSessionMessages({
        afterVersion: cursor,
        agentSessionId,
        order: "asc",
        signal,
        workspaceId
      });
      assertExecutionActive(signal);
      assertMessagePageIdentity(page, workspaceId, agentSessionId);
      if (shouldSkip(agentSessionId, signal)) return null;
      messages.push(...page.messages);
      const nextCursor = Math.max(
        cursor,
        normalizeVersion(page.latestVersion),
        latestMessageVersion(page.messages)
      );
      if (!page.hasMore) {
        input.onTrace?.({
          afterVersion,
          agentSessionId,
          latestVersion: nextCursor,
          messageCount: messages.length,
          messageVersion: session.messageVersion,
          requestedAgentSessionId,
          scope,
          status: "resolved",
          type: "messages"
        });
        return {
          agentSessionId,
          page: {
            hasMore: false,
            latestVersion: nextCursor,
            messages
          },
          startsAtNewestBoundary
        };
      }
      if (nextCursor <= cursor) {
        throw new Error(
          `session reconcile pagination did not advance for ${agentSessionId}`
        );
      }
      cursor = nextCursor;
    }
    throw new Error(
      `session reconcile exceeded ${MAX_MESSAGE_PAGES} message pages for ${agentSessionId}`
    );
  };

  return {
    async execute(command, options) {
      const agentSessionId = normalizeRequiredIdentity(
        command.agentSessionId,
        "agentSessionId"
      );
      if (
        normalizeRequiredIdentity(command.workspaceId, "workspaceId") !==
        workspaceId
      ) {
        throw new Error(
          `session reconcile workspace mismatch: expected ${workspaceId}, received ${command.workspaceId}`
        );
      }
      const signal = options?.signal;
      assertExecutionActive(signal);
      if (shouldSkip(agentSessionId, signal)) {
        assertExecutionActive(signal);
        return skippedResult();
      }
      if (command.scope === "state") {
        const detail = await getDetail(agentSessionId, "state", signal);
        if (shouldSkip(agentSessionId, signal)) {
          assertExecutionActive(signal);
          return skippedResult();
        }
        const filtered = withoutDeletedChildren(detail, input.isSessionDeleted);
        input.onTrace?.({
          detail: filtered,
          scope: command.scope,
          status: "applying",
          type: "detailApply"
        });
        input.engine.dispatch({
          ...filtered,
          ...(command.live ? { live: true } : {}),
          type: "session/detailSnapshotReceived",
          workspaceId
        });
        input.onTrace?.({
          detail: filtered,
          scope: command.scope,
          status: "applied",
          type: "detailApply"
        });
        return {
          affectedSessionIds: detailSessionIds(filtered),
          appliedMessages: [],
          session: filtered.session,
          status: "applied"
        };
      }

      if (command.scope === "messages") {
        const snapshot = readSnapshot();
        const session =
          snapshot.sessions.find(
            (candidate) => candidate.agentSessionId === agentSessionId
          ) ?? fallbackSession(agentSessionId);
        const page = await reconcilePage(
          session,
          snapshot.sessionMessagesById[agentSessionId] ?? [],
          snapshot.sessionMessageWindowsById?.[agentSessionId] !== undefined,
          agentSessionId,
          "messages",
          signal
        );
        if (!page) {
          assertExecutionActive(signal);
          return shouldSkip(agentSessionId, signal)
            ? skippedResult()
            : {
                affectedSessionIds: [],
                appliedMessages: [],
                session: null,
                status: "applied"
              };
        }
        input.engine.dispatch({
          messages: page.page.messages,
          ...(page.startsAtNewestBoundary
            ? {
                sessionMessageWindows: [
                  {
                    agentSessionId,
                    ...agentActivitySessionMessageWindowFromDescendingPage(
                      page.page
                    )
                  }
                ]
              }
            : {}),
          type: "message/snapshotReceived",
          workspaceId
        });
        input.reconcileOptimisticMessages(agentSessionId);
        return {
          affectedSessionIds: [agentSessionId],
          appliedMessages: page.page.messages,
          session: null,
          status: "applied"
        };
      }

      const discoveryDetail = await getDetail(
        agentSessionId,
        "discovery",
        signal
      );
      if (shouldSkip(agentSessionId, signal)) {
        assertExecutionActive(signal);
        return skippedResult();
      }
      const initialSnapshot = readSnapshot();
      const cachedMessagesBySessionId = new Map(
        Object.entries(initialSnapshot.sessionMessagesById)
      );
      const knownMessageWindows = new Set(
        Object.keys(initialSnapshot.sessionMessageWindowsById ?? {})
      );
      const pages: ReconciledMessagePage[] = [];

      const reconcileSessions = async (
        sessions: readonly AgentActivitySession[]
      ) => {
        const results = await Promise.all(
          sessions.map((session) =>
            reconcilePage(
              session,
              cachedMessagesBySessionId.get(session.agentSessionId) ?? [],
              knownMessageWindows.has(session.agentSessionId),
              agentSessionId,
              "combined",
              signal
            )
          )
        );
        for (const page of results) {
          if (!page) continue;
          pages.push(page);
          cachedMessagesBySessionId.set(
            page.agentSessionId,
            mergeAgentActivityMessages(
              cachedMessagesBySessionId.get(page.agentSessionId) ?? [],
              page.page.messages
            )
          );
          if (page.startsAtNewestBoundary) {
            knownMessageWindows.add(page.agentSessionId);
          }
        }
      };

      const filteredDiscoveryDetail = withoutDeletedChildren(
        discoveryDetail,
        input.isSessionDeleted
      );
      const discoveredSessions = sessionsToHydrate(
        filteredDiscoveryDetail,
        input.childMessageHydration
      );
      await reconcileSessions(discoveredSessions);
      if (shouldSkip(agentSessionId, signal)) {
        assertExecutionActive(signal);
        return skippedResult();
      }

      const finalDetail = await getDetail(agentSessionId, "final", signal);
      if (shouldSkip(agentSessionId, signal)) {
        assertExecutionActive(signal);
        return skippedResult();
      }
      const discoveredIds = new Set(
        discoveredSessions.map((session) => session.agentSessionId)
      );
      const filteredDetail = withoutDeletedChildren(
        finalDetail,
        input.isSessionDeleted
      );
      const finalSessions = sessionsToHydrate(
        filteredDetail,
        input.childMessageHydration
      );
      await reconcileSessions(
        finalSessions.filter((session) => {
          if (input.isSessionDeleted(session.agentSessionId)) return false;
          if (!discoveredIds.has(session.agentSessionId)) return true;
          return (
            latestDurableMessageVersion(
              cachedMessagesBySessionId.get(session.agentSessionId) ?? []
            ) < session.messageVersion
          );
        })
      );
      if (shouldSkip(agentSessionId, signal)) {
        assertExecutionActive(signal);
        return skippedResult();
      }

      const retainedSessionIds = new Set(detailSessionIds(filteredDetail));
      const appliedPages = pages.filter((page) =>
        retainedSessionIds.has(page.agentSessionId)
      );
      const appliedMessages = mergeReconciledPageMessages(appliedPages);
      input.onTrace?.({
        detail: filteredDetail,
        scope: command.scope,
        status: "applying",
        type: "detailApply"
      });
      input.engine.dispatch({
        ...filteredDetail,
        ...(command.live ? { live: true } : {}),
        messages: appliedMessages,
        sessionMessageWindows: appliedPages.flatMap((page) =>
          page.startsAtNewestBoundary
            ? [
                {
                  agentSessionId: page.agentSessionId,
                  ...agentActivitySessionMessageWindowFromDescendingPage(
                    page.page
                  )
                }
              ]
            : []
        ),
        type: "session/detailSnapshotReceived",
        workspaceId
      });
      input.onTrace?.({
        detail: filteredDetail,
        scope: command.scope,
        status: "applied",
        type: "detailApply"
      });
      const reconciledMessageSessionIds = [
        ...new Set(appliedPages.map((page) => page.agentSessionId))
      ];
      for (const reconciledSessionId of reconciledMessageSessionIds) {
        input.reconcileOptimisticMessages(reconciledSessionId);
      }
      return {
        affectedSessionIds: detailSessionIds(filteredDetail),
        appliedMessages,
        session: filteredDetail.session,
        status: "applied"
      };
    }
  };
}

function sessionsToHydrate(
  detail: AgentActivitySessionDetailSnapshot,
  childMessageHydration: AgentActivityChildMessageHydration
): AgentActivitySession[] {
  return childMessageHydration === "session_hierarchy"
    ? [detail.session, ...detail.childSessions]
    : [detail.session];
}

function mergeReconciledPageMessages(
  pages: readonly ReconciledMessagePage[]
): AgentActivityDurableMessage[] {
  const messagesBySessionId = new Map<string, AgentActivityDurableMessage[]>();
  for (const page of pages) {
    const messages = messagesBySessionId.get(page.agentSessionId) ?? [];
    messages.push(...page.page.messages);
    messagesBySessionId.set(page.agentSessionId, messages);
  }
  return [...messagesBySessionId.values()].flatMap((messages) =>
    mergeAgentActivityMessages([], messages)
  );
}

function withoutDeletedChildren(
  detail: AgentActivitySessionDetailSnapshot,
  isSessionDeleted: (agentSessionId: string) => boolean
): AgentActivitySessionDetailSnapshot {
  const removedIds = new Set(
    detail.childSessions
      .filter((session) => isSessionDeleted(session.agentSessionId))
      .map((session) => session.agentSessionId)
  );
  for (;;) {
    let removedDescendant = false;
    for (const session of detail.childSessions) {
      if (
        !removedIds.has(session.agentSessionId) &&
        session.parentAgentSessionId !== null &&
        removedIds.has(session.parentAgentSessionId)
      ) {
        removedIds.add(session.agentSessionId);
        removedDescendant = true;
      }
    }
    if (!removedDescendant) break;
  }
  const childSessions = detail.childSessions.filter(
    (session) => !removedIds.has(session.agentSessionId)
  );
  const retainedIds = new Set([
    detail.session.agentSessionId,
    ...childSessions.map((session) => session.agentSessionId)
  ]);
  return {
    session: detail.session,
    childSessions,
    turns: detail.turns.filter((turn) => retainedIds.has(turn.agentSessionId))
  };
}

function assertMessagePageIdentity(
  page: AgentActivityMessagePage,
  workspaceId: string,
  agentSessionId: string
): void {
  for (const message of page.messages) {
    if (message.agentSessionId.trim() !== agentSessionId) {
      throw new Error(
        `session reconcile message identity mismatch: expected ${agentSessionId}, received ${message.agentSessionId}`
      );
    }
    if (
      message.workspaceId !== undefined &&
      message.workspaceId.trim() !== workspaceId
    ) {
      throw new Error(
        `session reconcile message workspace mismatch: expected ${workspaceId}, received ${message.workspaceId}`
      );
    }
  }
}

function detailSessionIds(
  detail: AgentActivitySessionDetailSnapshot
): string[] {
  return [
    detail.session.agentSessionId,
    ...detail.childSessions.map((session) => session.agentSessionId)
  ];
}

function latestMessageVersion(
  messages: readonly AgentActivityMessage[]
): number {
  return messages.reduce(
    (latest, message) => Math.max(latest, normalizeVersion(message.version)),
    0
  );
}

function latestDurableMessageVersion(
  messages: readonly AgentActivityMessage[]
): number {
  return messages.reduce((latest, message) => {
    if (
      !Number.isSafeInteger(message.sequence) ||
      (message.sequence ?? 0) <= 0 ||
      !Number.isSafeInteger(message.version) ||
      message.version <= 0
    ) {
      return latest;
    }
    return Math.max(latest, message.version);
  }, 0);
}

function conversationReconcileAfterVersion(
  messages: readonly AgentActivityMessage[]
): number {
  const latest = latestMessageVersion(messages);
  if (
    messages.length === 0 ||
    messages.some((message) => message.role.trim().toLowerCase() === "user")
  ) {
    return latest;
  }
  return messages.some((message) => {
    const role = message.role.trim().toLowerCase();
    const kind = message.kind.trim().toLowerCase();
    return role === "assistant" || role === "agent" || kind === "tool_call";
  })
    ? 0
    : latest;
}

function normalizeVersion(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeRequiredIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`session reconcile ${field} is required`);
  return normalized;
}

function fallbackSession(agentSessionId: string): ReconcileSessionIdentity {
  return {
    agentSessionId,
    kind: "root",
    messageVersion: 0
  };
}
