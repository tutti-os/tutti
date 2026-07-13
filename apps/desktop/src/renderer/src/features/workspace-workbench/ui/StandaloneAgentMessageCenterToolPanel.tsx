import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { selectEnginePendingInteractions } from "@tutti-os/agent-activity-core";
import {
  buildWorkspaceAgentMessageCenterModelFromEngine,
  dispatchAgentPlanPromptAction,
  selectWorkspaceAgentMessageCenterPresentation,
  stabilizeWorkspaceAgentMessageCenterModel,
  useEngineSelector,
  workspaceAgentMessageCenterPromptStatus,
  WorkspaceAgentMessageCenterPanel,
  type WorkspaceAgentMessageCenterModel
} from "@tutti-os/agent-gui/agent-message-center";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { WorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import type { useTranslation } from "@renderer/i18n";
import { useExternalStoreValue } from "./useExternalStoreValue.ts";

interface StandaloneAgentMessageCenterToolPanelProps {
  activityService: WorkspaceAgentActivityService;
  i18n: I18nRuntime<string>;
  locale: ReturnType<typeof useTranslation>["locale"];
  open: boolean;
  workspaceId: string;
  onClose: () => void;
  onOpenChat: (input: { agentSessionId: string; provider: string }) => void;
}

export function StandaloneAgentMessageCenterToolPanel({
  activityService,
  i18n,
  locale,
  open,
  workspaceId,
  onClose,
  onOpenChat
}: StandaloneAgentMessageCenterToolPanelProps): ReactNode {
  const activitySnapshot = useExternalStoreValue(
    (listener) => activityService.subscribe(workspaceId, listener),
    () => activityService.getSnapshot(workspaceId),
    () => activityService.getSnapshot(workspaceId)
  );
  const sessionEngine = useMemo(
    () => activityService.getSessionEngine(workspaceId),
    [activityService, workspaceId]
  );
  const presentationState = useEngineSelector(
    sessionEngine,
    selectWorkspaceAgentMessageCenterPresentation
  );
  const modelRef = useRef<WorkspaceAgentMessageCenterModel | null>(null);
  const itemCutoffUnixMs = useMemo(
    () => Date.now() - 7 * 24 * 60 * 60 * 1000,
    [workspaceId]
  );
  const model = useMemo(() => {
    const nextModel = buildWorkspaceAgentMessageCenterModelFromEngine(
      presentationState,
      activitySnapshot,
      {
        itemCutoffUnixMs,
        promptFallbackLabels: {
          constraintHeader: i18n.t(
            "workspace.agentMessageCenter.promptConstraintHeader"
          ),
          inputHeader: i18n.t("workspace.agentMessageCenter.promptInputHeader"),
          question: i18n.t("workspace.agentMessageCenter.promptQuestion"),
          title: i18n.t("workspace.agentMessageCenter.promptTitle")
        },
        workspaceRoot: null
      }
    );
    const stableModel = stabilizeWorkspaceAgentMessageCenterModel(
      modelRef.current,
      nextModel
    );
    modelRef.current = stableModel;
    return stableModel;
  }, [activitySnapshot, i18n, itemCutoffUnixMs, presentationState]);
  const requestedSessionSummaryIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!open) {
      return;
    }
    for (const session of activitySnapshot.sessions.slice(0, 12)) {
      const agentSessionId = session.agentSessionId.trim();
      if (
        !agentSessionId ||
        requestedSessionSummaryIdsRef.current.has(agentSessionId) ||
        hasCachedSessionMessages(activitySnapshot, session)
      ) {
        continue;
      }
      requestedSessionSummaryIdsRef.current.add(agentSessionId);
      void activityService
        .listSessionMessages({
          agentSessionId,
          limit: 20,
          order: "desc",
          workspaceId
        })
        .catch(() => {
          requestedSessionSummaryIdsRef.current.delete(agentSessionId);
        });
    }
  }, [activityService, activitySnapshot, open, workspaceId]);

  const handleSubmitPrompt = useCallback(
    async (input: {
      action?: string;
      agentSessionId: string;
      optionId?: string;
      payload?: Record<string, unknown>;
      promptKind?: string;
      requestId: string;
    }) => {
      const engine = activityService.getSessionEngine(workspaceId);
      if (input.promptKind === "plan-implementation") {
        if (
          input.action === "implement" ||
          input.action === "feedback" ||
          input.action === "skip"
        ) {
          dispatchAgentPlanPromptAction({
            action: input.action,
            agentSessionId: input.agentSessionId,
            engine,
            feedbackText:
              typeof input.payload?.text === "string"
                ? input.payload.text
                : undefined,
            requestId: input.requestId,
            workspaceId
          });
        }
        return;
      }
      const interaction = selectEnginePendingInteractions(
        engine.getSnapshot(),
        input.agentSessionId
      ).find((candidate) => candidate.requestId === input.requestId);
      if (!interaction) return;
      engine.dispatch({
        type: "interaction/responseRequested",
        agentSessionId: input.agentSessionId,
        commandId: [
          workspaceId,
          input.agentSessionId,
          interaction.turnId,
          input.requestId
        ].join(":"),
        requestId: input.requestId,
        turnId: interaction.turnId,
        workspaceId,
        ...(input.action ? { action: input.action } : {}),
        ...(input.optionId ? { optionId: input.optionId } : {}),
        ...(input.payload ? { payload: input.payload } : {})
      });
    },
    [activityService, workspaceId]
  );
  const handleOpenChat = useCallback(
    (input: { agentSessionId: string; provider: string }) => {
      onOpenChat(input);
      onClose();
    },
    [onClose, onOpenChat]
  );

  return (
    <WorkspaceAgentMessageCenterPanel
      i18n={i18n}
      locale={locale}
      model={model}
      open={open}
      presentation="embedded"
      onClose={onClose}
      onOpenChat={handleOpenChat}
      promptStatus={(item) =>
        workspaceAgentMessageCenterPromptStatus(presentationState, item)
      }
      onSubmitPrompt={handleSubmitPrompt}
    />
  );
}

function hasCachedSessionMessages(
  snapshot: ReturnType<WorkspaceAgentActivityService["getSnapshot"]>,
  session: ReturnType<
    WorkspaceAgentActivityService["getSnapshot"]
  >["sessions"][number]
): boolean {
  return [session.agentSessionId, session.providerSessionId]
    .filter((value): value is string => Boolean(value?.trim()))
    .some(
      (sessionId) => (snapshot.sessionMessagesById[sessionId]?.length ?? 0) > 0
    );
}
