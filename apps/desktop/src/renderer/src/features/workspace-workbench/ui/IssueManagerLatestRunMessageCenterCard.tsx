import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from "react";
import { AgentGuiI18nProvider } from "@tutti-os/agent-gui/i18n";
import {
  buildWorkspaceAgentMessageCenterModelFromEngine,
  selectWorkspaceAgentMessageCenterPresentation,
  workspaceAgentMessageCenterPromptStatus,
  workspaceAgentMessageCenterPresentationEqual,
  WorkspaceAgentMessageCenterCard,
  dispatchAgentPlanPromptAction,
  useEngineSelector,
  type WorkspaceAgentMessageCenterCardProps,
  type WorkspaceAgentMessageCenterItem
} from "@tutti-os/agent-gui/agent-message-center";
import {
  selectEnginePendingInteractions,
  selectWorkspaceAgentConsumerSession,
  type AgentActivityMessage,
  type CanonicalAgentSession
} from "@tutti-os/agent-activity-core";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { DesktopLocale } from "@shared/i18n";
import type { IssueManagerLatestRunStatusRenderInput } from "@tutti-os/workspace-issue-manager/ui";
import type { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";

const MESSAGE_CENTER_SUMMARY_MESSAGE_LIMIT = 20;
type MessageCenterAgentSession = CanonicalAgentSession;

export function renderIssueManagerLatestRunMessageCenterCard(
  input: IssueManagerLatestRunStatusRenderInput,
  dependencies: {
    i18n: I18nRuntime<string>;
    locale: DesktopLocale;
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
      locale={dependencies.locale}
      onLinkAction={dependencies.onLinkAction}
      workspaceAgentActivityService={dependencies.workspaceAgentActivityService}
      workspaceId={dependencies.workspaceId}
    />
  );
}

function IssueManagerLatestRunMessageCenterCard({
  input,
  i18n,
  locale,
  onLinkAction,
  workspaceAgentActivityService,
  workspaceId
}: {
  input: IssueManagerLatestRunStatusRenderInput;
  i18n: I18nRuntime<string>;
  locale: DesktopLocale;
  onLinkAction?: WorkspaceAgentMessageCenterCardProps["onLinkAction"];
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceId: string;
}): JSX.Element {
  const requestedMessageSummarySessionIdsRef = useRef<Set<string>>(new Set());
  const [sessionMessagesById, setSessionMessagesById] = useState<
    Record<string, AgentActivityMessage[]>
  >({});
  const agentSessionId = input.latestRun.agentSessionId?.trim() ?? "";
  const sessionEngine = useMemo(
    () => workspaceAgentActivityService.getSessionEngine(workspaceId),
    [workspaceAgentActivityService, workspaceId]
  );
  const messageCenterPresentation = useEngineSelector(
    sessionEngine,
    selectWorkspaceAgentMessageCenterPresentation,
    workspaceAgentMessageCenterPresentationEqual
  );
  const targetSessionConsumer = useEngineSelector(
    sessionEngine,
    useCallback(
      (state) => selectWorkspaceAgentConsumerSession(state, agentSessionId),
      [agentSessionId]
    ),
    workspaceAgentConsumerSessionEqual
  );

  const model = useMemo(
    () =>
      buildWorkspaceAgentMessageCenterModelFromEngine(
        messageCenterPresentation,
        { sessionMessagesById, workspaceId },
        {
          promptFallbackLabels: {
            constraintHeader: i18n.t(
              "workspace.agentMessageCenter.promptConstraintHeader"
            ),
            inputHeader: i18n.t(
              "workspace.agentMessageCenter.promptInputHeader"
            ),
            question: i18n.t("workspace.agentMessageCenter.promptQuestion"),
            title: i18n.t("workspace.agentMessageCenter.promptTitle")
          },
          workspaceRoot: null
        }
      ),
    [i18n, messageCenterPresentation, sessionMessagesById, workspaceId]
  );
  const targetSession = targetSessionConsumer?.session ?? null;
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
  const promptStatus = workspaceAgentMessageCenterPromptStatus(
    messageCenterPresentation,
    item
  );

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
      hasCachedWorkspaceAgentSessionMessages(sessionMessagesById, targetSession)
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
      .then((page) => {
        setSessionMessagesById((current) => ({
          ...current,
          [sessionId]: page.messages
        }));
      })
      .catch((error: unknown) => {
        requestedMessageSummarySessionIdsRef.current.delete(sessionId);
        console.error(
          "[workspace-agent-message-summary]",
          JSON.stringify({
            agentSessionId: sessionId,
            error: error instanceof Error ? error.message : String(error),
            workspaceId
          })
        );
      });

    return () => {
      abortController.abort();
    };
  }, [
    agentSessionId,
    sessionMessagesById,
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
      const commandId = [
        workspaceId,
        item.agentSessionId,
        "interaction",
        submitInput.requestId
      ].join(":");
      if (
        item.pendingPrompt?.kind === "plan-implementation" &&
        (submitInput.action === "implement" ||
          submitInput.action === "feedback" ||
          submitInput.action === "skip")
      ) {
        dispatchAgentPlanPromptAction({
          action: submitInput.action,
          agentSessionId: item.agentSessionId,
          engine: sessionEngine,
          feedbackText:
            typeof submitInput.payload?.text === "string"
              ? submitInput.payload.text
              : undefined,
          requestId: submitInput.requestId,
          workspaceId
        });
      } else {
        const interaction = selectEnginePendingInteractions(
          sessionEngine.getSnapshot(),
          item.agentSessionId
        ).find((candidate) => candidate.requestId === submitInput.requestId);
        if (!interaction) return;
        sessionEngine.dispatch({
          type: "interaction/responseRequested",
          agentSessionId: item.agentSessionId,
          commandId,
          requestId: submitInput.requestId,
          turnId: interaction.turnId,
          workspaceId,
          ...(submitInput.action ? { action: submitInput.action } : {}),
          ...(submitInput.optionId ? { optionId: submitInput.optionId } : {}),
          ...(submitInput.payload ? { payload: submitInput.payload } : {})
        });
      }
    },
    [item.agentSessionId, item.pendingPrompt?.kind, sessionEngine, workspaceId]
  );

  return (
    <AgentGuiI18nProvider runtime={i18n} locale={locale}>
      <WorkspaceAgentMessageCenterCard
        isSubmitting={
          promptStatus === "responding" || promptStatus === "unknown"
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

function workspaceAgentConsumerSessionEqual(
  left: ReturnType<typeof selectWorkspaceAgentConsumerSession>,
  right: ReturnType<typeof selectWorkspaceAgentConsumerSession>
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.session === right.session &&
      left.activeTurn === right.activeTurn &&
      left.latestTurn === right.latestTurn &&
      left.displayStatus === right.displayStatus &&
      left.pendingInteractions.length === right.pendingInteractions.length &&
      left.pendingInteractions.every(
        (interaction, index) => interaction === right.pendingInteractions[index]
      ))
  );
}

function findWorkspaceAgentMessageCenterItem({
  agentSessionId,
  itemCandidates,
  session
}: {
  agentSessionId: string;
  itemCandidates: readonly WorkspaceAgentMessageCenterItem[];
  session: MessageCenterAgentSession | null;
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
  sessionMessagesById: Readonly<Record<string, AgentActivityMessage[]>>,
  session: MessageCenterAgentSession
): boolean {
  return workspaceAgentSessionMessageAliases(session).some(
    (alias) => (sessionMessagesById[alias]?.length ?? 0) > 0
  );
}

function workspaceAgentSessionMessageAliases(
  session: MessageCenterAgentSession
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
