import { useEffect, useMemo } from "react";
import { InstantiationContext } from "@tutti-os/infra/di";
import { AnalyticsDebugFloatingEntryGate } from "@renderer/features/analytics-debug";
import { AppUpdateStatus } from "@renderer/features/app-update";
import { WorkspaceWorkbench } from "@renderer/features/workspace-workbench";
import { useTranslation } from "../../../i18n";
import { Toast } from "../../../lib/toast";
import { createWorkspaceWindowContainer } from "./createWorkspaceWindowContainer";
import { createDeferredWorkspaceContainerDispose } from "./deferredWorkspaceContainerDispose";

export function WorkspaceWindow() {
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
  } = useMemo(() => createWorkspaceWindowContainer(), []);
  const containerDispose = useMemo(
    () => createDeferredWorkspaceContainerDispose(() => container.dispose()),
    [container]
  );
  const initialSearch = window.location.search;
  const searchParams = new URLSearchParams(initialSearch);
  const routeView = searchParams.get("view") || "workspace";
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
      Toast.tips(t("desktop.quitShortcut.confirmToastTitle"));
    });
  }, [hostWindowApi, t]);

  return (
    <InstantiationContext instantiationService={container}>
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
    </InstantiationContext>
  );
}
