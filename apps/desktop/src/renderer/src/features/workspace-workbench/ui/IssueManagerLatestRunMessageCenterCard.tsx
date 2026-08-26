import { useCallback, useEffect, useMemo, useRef, type JSX } from "react";
import { AgentGuiI18nProvider } from "@tutti-os/agent-gui/i18n";
import {
  buildWorkspaceAgentMessageCenterModelFromEngine,
  selectWorkspaceAgentMessageCenterPresentation,
  workspaceAgentMessageCenterPromptStatus,
  workspaceAgentMessageCenterPresentationEqual,
  WorkspaceAgentMessageCenterCard,
  dispatchAgentPlanPromptAction,
  useEngineSelector,
  type WorkspaceAgentMessageCenterCardProps
} from "@tutti-os/agent-gui/agent-message-center";
import {
  selectSessionMessagesById,
  selectWorkspaceAgentConsumerSession
} from "@tutti-os/agent-activity-core";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { DesktopLocale } from "@shared/i18n";
import type { IssueManagerLatestRunStatusRenderInput } from "@tutti-os/workspace-issue-manager/ui";
import type { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import {
  hasCachedWorkspaceAgentSessionMessages,
  resolveIssueManagerLatestRunMessageCenterItem,
  submitIssueManagerPendingInteraction,
  synchronizeIssueManagerLatestRunSession
} from "./issueManagerLatestRunMessageCenterItem.ts";

const MESSAGE_CENTER_SUMMARY_MESSAGE_LIMIT = 20;

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
  const agentSessionId = input.latestRun.agentSessionId?.trim() ?? "";
  const sessionEngine = useMemo(
    () => workspaceAgentActivityService.getSessionEngine(workspaceId),
    [workspaceAgentActivityService, workspaceId]
  );
  const sessionMessagesById = useEngineSelector(
    sessionEngine,
    selectSessionMessagesById
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

  useEffect(
    () =>
      synchronizeIssueManagerLatestRunSession({
        agentSessionId,
        service: workspaceAgentActivityService,
        workspaceId
      }),
    [agentSessionId, workspaceAgentActivityService, workspaceId]
  );

  const model = useMemo(
    () =>
      buildWorkspaceAgentMessageCenterModelFromEngine(
        messageCenterPresentation,
        { sessionMessagesById, workspaceId },
        {
          // Tutti Mode delegate runs are hidden from ambient surfaces; this
          // card's subject IS the delegate session, so keep it in the model
          // so its pending prompts stay renderable and answerable here.
          includeHiddenSessionIds: agentSessionId ? [agentSessionId] : [],
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
    [
      agentSessionId,
      i18n,
      messageCenterPresentation,
      sessionMessagesById,
      workspaceId
    ]
  );
  const targetSession = targetSessionConsumer?.session ?? null;
  const item = useMemo(
    () =>
      resolveIssueManagerLatestRunMessageCenterItem({
        agentSessionId,
        input,
        itemCandidates: model.items,
        session: targetSession
      }),
    [agentSessionId, input, model.items, targetSession]
  );
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
        submitIssueManagerPendingInteraction({
          engine: sessionEngine,
          item,
          submitInput
        });
      }
    },
    [
      item.agentSessionId,
      item.pendingInteractionTarget,
      item.pendingPrompt?.kind,
      sessionEngine,
      workspaceId
    ]
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
