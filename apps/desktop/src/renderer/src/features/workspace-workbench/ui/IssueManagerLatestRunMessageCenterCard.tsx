import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type MutableRefObject
} from "react";
import { AgentGuiI18nProvider } from "@tutti-os/agent-gui";
import {
  buildWorkspaceAgentMessageCenterModel,
  WorkspaceAgentMessageCenterCard,
  type WorkspaceAgentMessageCenterCardProps,
  type WorkspaceAgentMessageCenterItem
} from "@tutti-os/agent-gui/agent-message-center";
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { IssueManagerLatestRunStatusRenderInput } from "@tutti-os/workspace-issue-manager/ui";
import type { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";

const MESSAGE_CENTER_SUMMARY_MESSAGE_LIMIT = 20;
type WorkspaceAgentActivitySession = AgentActivitySnapshot["sessions"][number];

export function renderIssueManagerLatestRunMessageCenterCard(
  input: IssueManagerLatestRunStatusRenderInput,
  dependencies: {
    i18n: I18nRuntime<string>;
    onLinkAction?: WorkspaceAgentMessageCenterCardProps["onLinkAction"];
    workspaceAgentActivityService: IWorkspaceAgentActivityService;
    workspaceId: string;
  }
): JSX.Element | null {
  if (!input.canOpenAgentSession) {
    return null;
  }

  return (
    <IssueManagerLatestRunMessageCenterCard
      input={input}
      i18n={dependencies.i18n}
      onLinkAction={dependencies.onLinkAction}
      workspaceAgentActivityService={dependencies.workspaceAgentActivityService}
      workspaceId={dependencies.workspaceId}
    />
  );
}

function IssueManagerLatestRunMessageCenterCard({
  input,
  i18n,
  onLinkAction,
  workspaceAgentActivityService,
  workspaceId
}: {
  input: IssueManagerLatestRunStatusRenderInput;
  i18n: I18nRuntime<string>;
  onLinkAction?: WorkspaceAgentMessageCenterCardProps["onLinkAction"];
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceId: string;
}): JSX.Element {
  const requestedMessageSummarySessionIdsRef = useRef<Set<string>>(new Set());
  const snapshotRef = useRef<{
    snapshot: AgentActivitySnapshot;
    workspaceId: string;
  } | null>(null);
  const [submittingPromptKey, setSubmittingPromptKey] = useState<string | null>(
    null
  );
  const agentSessionId = input.latestRun.agentSessionId?.trim() ?? "";
  const readSnapshot = useCallback(
    () =>
      readWorkspaceAgentActivitySnapshot({
        snapshotRef,
        workspaceAgentActivityService,
        workspaceId
      }),
    [workspaceAgentActivityService, workspaceId]
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      let disposed = false;
      const unsubscribe = workspaceAgentActivityService.subscribe(
        workspaceId,
        (nextSnapshot) => {
          snapshotRef.current = {
            snapshot: nextSnapshot,
            workspaceId
          };
          queueMicrotask(() => {
            if (!disposed) {
              listener();
            }
          });
        }
      );
      return () => {
        disposed = true;
        unsubscribe();
      };
    },
    [workspaceAgentActivityService, workspaceId]
  );
  const snapshot = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);

  useEffect(() => {
    void workspaceAgentActivityService.load(workspaceId);
  }, [workspaceAgentActivityService, workspaceId]);

  // The workspace agent activity snapshot only tracks a session once the
  // service has reconciled it (a request round-trip after the run starts).
  // While a run is actively streaming, the issue-manager latest-run card
  // otherwise has to fall back to a bare status digest (no real message
  // content) even though the message summary fetch below may already have
  // cached the actual reply. Synthesize a session entry from those cached
  // messages so the same message-center projection (digest + full turn
  // detail) used for a tracked session renders here too, instead of only
  // after the run finishes and a later snapshot reconcile catches up.
  const messageCenterSnapshot = useMemo(
    () =>
      issueManagerLatestRunMessageCenterSnapshot({
        agentSessionId,
        input,
        snapshot
      }),
    [agentSessionId, input, snapshot]
  );
  const model = useMemo(
    () =>
      buildWorkspaceAgentMessageCenterModel(messageCenterSnapshot, {
        promptFallbackLabels: {
          constraintHeader: i18n.t(
            "workspace.agentMessageCenter.promptConstraintHeader"
          ),
          inputHeader: i18n.t("workspace.agentMessageCenter.promptInputHeader"),
          question: i18n.t("workspace.agentMessageCenter.promptQuestion"),
          title: i18n.t("workspace.agentMessageCenter.promptTitle")
        },
        workspaceRoot: null
      }),
    [i18n, messageCenterSnapshot]
  );
  const targetSession = useMemo(
    () => findWorkspaceAgentSession(messageCenterSnapshot, agentSessionId),
    [agentSessionId, messageCenterSnapshot]
  );
  const modelItem = useMemo(
    () =>
      findWorkspaceAgentMessageCenterItem({
        agentSessionId,
        itemCandidates: model.items,
        session: targetSession
      }),
    [agentSessionId, model.items, targetSession]
  );
  const item =
    modelItem ??
    createIssueManagerFallbackMessageCenterItem({
      agentSessionId,
      input
    });

  useEffect(() => {
    const sessionId =
      targetSession?.agentSessionId.trim() ||
      targetSession?.providerSessionId?.trim() ||
      agentSessionId;
    if (!sessionId) {
      return undefined;
    }
    if (requestedMessageSummarySessionIdsRef.current.has(sessionId)) {
      return undefined;
    }
    if (
      targetSession &&
      hasCachedWorkspaceAgentSessionMessages(
        snapshot.sessionMessagesById,
        targetSession
      )
    ) {
      return undefined;
    }

    requestedMessageSummarySessionIdsRef.current.add(sessionId);
    const abortController = new AbortController();
    void workspaceAgentActivityService
      .listSessionMessages({
        agentSessionId: sessionId,
        limit: MESSAGE_CENTER_SUMMARY_MESSAGE_LIMIT,
        order: "desc",
        signal: abortController.signal,
        workspaceId
      })
      .catch(() => {
        requestedMessageSummarySessionIdsRef.current.delete(sessionId);
      });

    return () => {
      abortController.abort();
    };
  }, [
    agentSessionId,
    snapshot.sessionMessagesById,
    targetSession,
    workspaceAgentActivityService,
    workspaceId
  ]);

  const submitPrompt = useCallback(
    async (submitInput: {
      action?: string;
      optionId?: string;
      payload?: Record<string, unknown>;
      requestId: string;
    }) => {
      const promptKey = `${item.agentSessionId}:${submitInput.requestId}`;
      setSubmittingPromptKey(promptKey);
      try {
        // Route through submitPlanDecision (same as the message-center deck):
        // a synthesized Codex "plan-implementation" prompt needs planMode-off +
        // literal send, not a submitInteractive call. promptKind is carried by
        // the item's pending prompt; other kinds fall through to submitInteractive.
        await workspaceAgentActivityService.submitPlanDecision({
          workspaceId,
          agentSessionId: item.agentSessionId,
          promptKind: item.pendingPrompt?.kind ?? "",
          requestId: submitInput.requestId,
          ...(submitInput.action ? { action: submitInput.action } : {}),
          ...(submitInput.optionId ? { optionId: submitInput.optionId } : {}),
          ...(submitInput.payload ? { payload: submitInput.payload } : {})
        });
      } finally {
        setSubmittingPromptKey((current) =>
          current === promptKey ? null : current
        );
      }
    },
    [
      item.agentSessionId,
      item.pendingPrompt?.kind,
      workspaceAgentActivityService,
      workspaceId
    ]
  );

  return (
    <AgentGuiI18nProvider runtime={i18n}>
      <WorkspaceAgentMessageCenterCard
        isSubmitting={
          item.pendingPrompt
            ? submittingPromptKey ===
              `${item.agentSessionId}:${item.pendingPrompt.requestId}`
            : false
        }
        item={item}
        onOpenChat={() => {
          void input.onOpenAgentSession?.(input.latestRun);
        }}
        onLinkAction={onLinkAction}
        onSubmitPrompt={(submitInput) => {
          void submitPrompt(submitInput);
        }}
      />
    </AgentGuiI18nProvider>
  );
}

function readWorkspaceAgentActivitySnapshot({
  snapshotRef,
  workspaceAgentActivityService,
  workspaceId
}: {
  snapshotRef: MutableRefObject<{
    snapshot: AgentActivitySnapshot;
    workspaceId: string;
  } | null>;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceId: string;
}): AgentActivitySnapshot {
  if (snapshotRef.current?.workspaceId === workspaceId) {
    return snapshotRef.current.snapshot;
  }
  const snapshot = workspaceAgentActivityService.getSnapshot(workspaceId);
  snapshotRef.current = {
    snapshot,
    workspaceId
  };
  return snapshot;
}

function findWorkspaceAgentSession(
  snapshot: AgentActivitySnapshot,
  agentSessionId: string
): WorkspaceAgentActivitySession | null {
  const target = agentSessionId.trim();
  if (!target) {
    return null;
  }
  return (
    snapshot.sessions.find((session) =>
      workspaceAgentSessionMessageAliases(session).includes(target)
    ) ?? null
  );
}

function issueManagerLatestRunMessageCenterSnapshot({
  agentSessionId,
  input,
  snapshot
}: {
  agentSessionId: string;
  input: IssueManagerLatestRunStatusRenderInput;
  snapshot: AgentActivitySnapshot;
}): AgentActivitySnapshot {
  if (
    !agentSessionId ||
    findWorkspaceAgentSession(snapshot, agentSessionId) ||
    !hasCachedIssueManagerRunMessages(
      snapshot.sessionMessagesById,
      agentSessionId
    )
  ) {
    return snapshot;
  }
  const latestRun = input.latestRun;
  const timestamp = issueManagerRunTimestampToUnixMs(
    latestRun.updatedAtUnix ??
      latestRun.completedAtUnix ??
      latestRun.startedAtUnix ??
      latestRun.createdAtUnix
  );
  return {
    ...snapshot,
    sessions: [
      ...snapshot.sessions,
      {
        workspaceId: snapshot.workspaceId || latestRun.workspaceId,
        agentSessionId,
        provider: latestRun.agentProvider?.trim() || "codex",
        cwd: latestRun.executionDirectory?.trim() || "",
        title: input.title || agentSessionId,
        status: issueManagerRunStatusToAgentActivityStatus(latestRun.status),
        userId: latestRun.requesterUserId?.trim() || undefined,
        visible: true,
        createdAtUnixMs: issueManagerRunTimestampToUnixMs(
          latestRun.createdAtUnix
        ),
        startedAtUnixMs: issueManagerRunTimestampToUnixMs(
          latestRun.startedAtUnix
        ),
        endedAtUnixMs: issueManagerRunTimestampToUnixMs(
          latestRun.completedAtUnix
        ),
        updatedAtUnixMs: timestamp,
        lastEventUnixMs: timestamp
      }
    ]
  };
}

function hasCachedIssueManagerRunMessages(
  sessionMessagesById: AgentActivitySnapshot["sessionMessagesById"],
  agentSessionId: string
): boolean {
  return (sessionMessagesById[agentSessionId.trim()]?.length ?? 0) > 0;
}

function issueManagerRunStatusToAgentActivityStatus(status: string): string {
  switch (status) {
    case "running":
    case "in_progress":
      return "working";
    case "pending_acceptance":
      return "waiting";
    case "completed":
    case "failed":
    case "canceled":
      return status;
    case "not_started":
      return "queued";
    default:
      return "unknown";
  }
}

function findWorkspaceAgentMessageCenterItem({
  agentSessionId,
  itemCandidates,
  session
}: {
  agentSessionId: string;
  itemCandidates: readonly WorkspaceAgentMessageCenterItem[];
  session: WorkspaceAgentActivitySession | null;
}): WorkspaceAgentMessageCenterItem | null {
  const aliases = new Set([
    agentSessionId.trim(),
    ...(session ? workspaceAgentSessionMessageAliases(session) : [])
  ]);
  aliases.delete("");
  return (
    itemCandidates.find((item) => aliases.has(item.agentSessionId.trim())) ??
    null
  );
}

function createIssueManagerFallbackMessageCenterItem({
  agentSessionId,
  input
}: {
  agentSessionId: string;
  input: IssueManagerLatestRunStatusRenderInput;
}): WorkspaceAgentMessageCenterItem {
  const latestRun = input.latestRun;
  const provider = latestRun.agentProvider?.trim() || "codex";
  const summary =
    latestRun.status === "failed"
      ? latestRun.errorMessage?.trim() || latestRun.summary?.trim() || ""
      : latestRun.summary?.trim() || "";
  const sortTimeUnixMs = issueManagerRunTimestampToUnixMs(
    latestRun.updatedAtUnix ??
      latestRun.completedAtUnix ??
      latestRun.startedAtUnix ??
      latestRun.createdAtUnix
  );
  const status = issueManagerRunStatusToMessageCenterStatus(latestRun.status);
  const digestSummary = summary || input.title || agentSessionId;

  return {
    agentSessionId,
    cwd: "",
    id: `issue-manager-run-${latestRun.runId}`,
    identity: null,
    lastAgentMessageAtUnixMs: sortTimeUnixMs || null,
    lastAgentMessageSummary: summary,
    digest: {
      primary: {
        kind: issueManagerRunStatusToDigestKind(status),
        summary: digestSummary,
        occurredAtUnixMs: sortTimeUnixMs || null
      }
    },
    needsAttentionKind: null,
    needsAttentionSummary: null,
    pendingPrompt: null,
    provider,
    sortTimeUnixMs,
    status,
    title: input.title || agentSessionId,
    userId: null
  };
}

function issueManagerRunStatusToMessageCenterStatus(
  status: string
): WorkspaceAgentMessageCenterItem["status"] {
  switch (status) {
    case "running":
      return "working";
    case "pending_acceptance":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "idle";
  }
}

function issueManagerRunStatusToDigestKind(
  status: WorkspaceAgentMessageCenterItem["status"]
): WorkspaceAgentMessageCenterItem["digest"]["primary"]["kind"] {
  switch (status) {
    case "failed":
      return "error";
    case "completed":
    case "canceled":
    case "idle":
      return "outcome";
    case "working":
      return "progress";
    default:
      return "summary";
  }
}

function issueManagerRunTimestampToUnixMs(
  value: number | null | undefined
): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const timestamp = Number(value);
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

function hasCachedWorkspaceAgentSessionMessages(
  sessionMessagesById: AgentActivitySnapshot["sessionMessagesById"],
  session: WorkspaceAgentActivitySession
): boolean {
  return workspaceAgentSessionMessageAliases(session).some(
    (alias) => (sessionMessagesById[alias]?.length ?? 0) > 0
  );
}

function workspaceAgentSessionMessageAliases(
  session: WorkspaceAgentActivitySession
): string[] {
  return [
    session.agentSessionId,
    session.providerSessionId ?? "",
    session.agentSessionId.trim(),
    (session.providerSessionId ?? "").trim()
  ].filter((alias, index, aliases) => {
    const normalized = alias.trim();
    return normalized.length > 0 && aliases.indexOf(alias) === index;
  });
}
