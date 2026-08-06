import { useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import {
  buildWorkspaceAgentMessageCenterModelFromEngine,
  selectWorkspaceAgentMessageCenterPresentation,
  stabilizeWorkspaceAgentMessageCenterModel,
  useEngineSelector,
  workspaceAgentMessageCenterPresentationEqual,
  type WorkspaceAgentMessageCenterModel
} from "@tutti-os/agent-gui/agent-message-center";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { WorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import { IAgentsService } from "@renderer/features/workspace-agent/services/agentsService.interface.ts";
import { useService } from "@tutti-os/infra/di";
import { useWorkspaceAgentDecisionNotifications } from "./useWorkspaceAgentDecisionNotifications.tsx";

const MESSAGE_CENTER_VISIBLE_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const emptySessionMessagesById = {};

export function StandaloneAgentDecisionNotifications({
  activityService,
  i18n,
  messageCenterOpen,
  workspaceId
}: {
  activityService: WorkspaceAgentActivityService;
  i18n: I18nRuntime<string>;
  messageCenterOpen: boolean;
  workspaceId: string;
}): ReactNode {
  const agentsService = useService(IAgentsService);
  const agentDirectory = useSyncExternalStore(
    (listener) => agentsService.subscribe(listener),
    () => agentsService.getSnapshot(),
    () => agentsService.getSnapshot()
  );
  const sessionEngine = useMemo(
    () => activityService.getSessionEngine(workspaceId),
    [activityService, workspaceId]
  );
  const presentation = useEngineSelector(
    sessionEngine,
    selectWorkspaceAgentMessageCenterPresentation,
    workspaceAgentMessageCenterPresentationEqual
  );
  const itemCutoffUnixMs = useMemo(
    () => Date.now() - MESSAGE_CENTER_VISIBLE_HISTORY_MS,
    [workspaceId]
  );
  const modelRef = useRef<WorkspaceAgentMessageCenterModel | null>(null);
  const modelWorkspaceIdRef = useRef<string | null>(null);
  const model = useMemo(() => {
    if (modelWorkspaceIdRef.current !== workspaceId) {
      modelWorkspaceIdRef.current = workspaceId;
      modelRef.current = null;
    }
    const nextModel = buildWorkspaceAgentMessageCenterModelFromEngine(
      presentation,
      {
        sessionMessagesById: emptySessionMessagesById,
        workspaceId
      },
      {
        agentPresentations: agentDirectory.agents,
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
  }, [
    agentDirectory.agents,
    i18n,
    itemCutoffUnixMs,
    presentation,
    workspaceId
  ]);

  useWorkspaceAgentDecisionNotifications({
    messageCenterOpen,
    model,
    sendBackgroundNotification: false,
    sessionEngine,
    workspaceId
  });

  return null;
}
