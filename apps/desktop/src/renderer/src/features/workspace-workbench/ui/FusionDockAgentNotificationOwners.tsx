import { useCallback, useEffect, useRef } from "react";
import type { DesktopFusionApi } from "@preload/types";
import { useService } from "@tutti-os/infra/di";
import { INotificationService } from "@tutti-os/ui-notifications";
import { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import { useTranslation } from "@renderer/i18n";
import {
  disposeFusionDockAgentOutcomeNotificationControllers,
  reconcileFusionDockAgentOutcomeNotificationControllers,
  type DisposableAgentOutcomeNotificationController
} from "../services/fusionDockAgentNotificationOwners.ts";
import { createWorkspaceAgentOutcomeNotificationController } from "../services/workspaceAgentOutcomeNotification.ts";
import { openFusionNotificationAgent } from "../services/fusionDockAgentBridge.ts";
import { createWorkspaceAgentOutcomeForegroundNotificationPresenter } from "./WorkspaceAgentOutcomeNotificationToast.tsx";
import { WorkspaceAgentWaitingNotificationOwner } from "./WorkspaceAgentWaitingNotificationOwner.tsx";

export function FusionDockAgentNotificationOwners({
  fusionApi,
  workspaceIds
}: {
  fusionApi: DesktopFusionApi;
  workspaceIds: readonly string[];
}) {
  const { t } = useTranslation();
  const notifications = useService(INotificationService);
  const workspaceAgentActivityService = useService(
    IWorkspaceAgentActivityService
  );
  const translateRef = useRef(t);
  translateRef.current = t;
  const controllersRef = useRef<
    Map<string, DisposableAgentOutcomeNotificationController>
  >(new Map());
  const createController = useCallback(
    (workspaceId: string) =>
      createWorkspaceAgentOutcomeNotificationController({
        foreground: createWorkspaceAgentOutcomeForegroundNotificationPresenter({
          openAgent: (notification) =>
            openFusionNotificationAgent({
              fusionApi,
              payload: {
                agentSessionId: notification.agentSessionId,
                provider: notification.provider,
                workspaceId: notification.workspaceId
              }
            })
        }),
        notifications,
        translate: (key, params) => translateRef.current(key, params),
        workspaceAgentActivityService,
        workspaceId
      }),
    [fusionApi, notifications, workspaceAgentActivityService]
  );

  useEffect(() => {
    reconcileFusionDockAgentOutcomeNotificationControllers({
      controllers: controllersRef.current,
      createController,
      workspaceIds
    });
  }, [createController, workspaceIds]);

  useEffect(
    () => () => {
      disposeFusionDockAgentOutcomeNotificationControllers(
        controllersRef.current
      );
    },
    []
  );

  return workspaceIds.map((workspaceId) => (
    <WorkspaceAgentWaitingNotificationOwner
      key={workspaceId}
      showDecisionToasts={false}
      workspaceId={workspaceId}
    />
  ));
}
