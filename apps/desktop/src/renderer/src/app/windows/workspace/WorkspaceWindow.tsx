import { useEffect, useMemo } from "react";
import { InstantiationContext } from "@tutti-os/infra/di";
import { AnalyticsDebugFloatingEntryGate } from "@renderer/features/analytics-debug";
import { AppUpdateStatus } from "@renderer/features/app-update";
import {
  FusionDockWindow,
  FusionToolWindow,
  WorkspaceWorkbench
} from "@renderer/features/workspace-workbench";
import { resolveDesktopWindowIntent } from "@shared/contracts/windowIntent.ts";
import { rendererRouteOwnsAgentOutcomeNotifications } from "@renderer/features/workspace-workbench/services/fusionWindowModel.ts";
import { useTranslation } from "../../../i18n";
import { Toast } from "../../../lib/toast";
import { createWorkspaceWindowContainer } from "./createWorkspaceWindowContainer";
import { createDeferredWorkspaceContainerDispose } from "./deferredWorkspaceContainerDispose";

export function WorkspaceWindow() {
  const initialSearch = window.location.search;
  const windowIntent = resolveDesktopWindowIntent(initialSearch);
  const searchParams = new URLSearchParams(initialSearch);
  const routeView = searchParams.get("view") || "workspace";
  const {
    container,
    agentProviderStatusService,
    desktopApi,
    environmentMode,
    hostWindowApi,
    reporterService,
    richTextAtService,
    startupWorkspaceID,
    tuttidClient,
    workspaceAgentActivityService,
    workspaceAppCenterService,
    workspaceAppExternalApi,
    workspaceUserProjectService
  } = useMemo(
    () =>
      createWorkspaceWindowContainer({
        ownsAgentOutcomeNotifications:
          rendererRouteOwnsAgentOutcomeNotifications(routeView)
      }),
    [routeView]
  );
  const containerDispose = useMemo(
    () => createDeferredWorkspaceContainerDispose(() => container.dispose()),
    [container]
  );
  const requestedWorkspaceID = searchParams.get("workspaceId");
  const workspaceID = requestedWorkspaceID || startupWorkspaceID;
  const { t } = useTranslation();

  useEffect(() => {
    containerDispose.cancel();
    return () => {
      containerDispose.schedule();
    };
  }, [containerDispose]);

  useEffect(() => {
    return hostWindowApi.onQuitShortcutToast(() => {
      const isFusionWindow =
        windowIntent.kind === "fusion-dock" ||
        windowIntent.kind === "fusion-tool" ||
        (windowIntent.kind === "agent" &&
          Boolean(windowIntent.windowInstanceID));
      Toast.tips(
        t(
          isFusionWindow
            ? "desktop.quitShortcut.confirmFusionToastTitle"
            : "desktop.quitShortcut.confirmToastTitle"
        )
      );
    });
  }, [hostWindowApi, t, windowIntent]);

  return (
    <InstantiationContext instantiationService={container}>
      {windowIntent.kind === "fusion-dock" ? (
        <FusionDockWindow
          desktopApi={desktopApi}
          workspaceId={windowIntent.workspaceID}
        />
      ) : windowIntent.kind === "fusion-tool" ? (
        <FusionToolWindow
          desktopApi={desktopApi}
          kind={windowIntent.fusionWindowKind}
          launchPayload={windowIntent.launchPayload}
          resourceId={windowIntent.resourceID}
          windowInstanceId={windowIntent.windowInstanceID}
          workspaceAppExternalApi={workspaceAppExternalApi}
          workspaceId={windowIntent.workspaceID}
        />
      ) : (
        <>
          <WorkspaceWorkbench
            agentWindowInput={{
              agentProviderStatusService,
              desktopApi,
              hostWindowApi,
              reporterService,
              richTextAtService,
              tuttidClient,
              workspaceAgentActivityService,
              workspaceAppCenterService,
              workspaceUserProjectService
            }}
            enableWindowCloseGuard={environmentMode === "desktop"}
            headerSlot={<AppUpdateStatus />}
            routeView={routeView}
            workspaceAppExternalApi={workspaceAppExternalApi}
            workspaceID={workspaceID}
          />
          <AnalyticsDebugFloatingEntryGate />
        </>
      )}
    </InstantiationContext>
  );
}
