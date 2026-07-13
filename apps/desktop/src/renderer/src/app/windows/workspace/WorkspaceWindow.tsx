import { lazy, Suspense, useEffect, useMemo } from "react";
import { InstantiationContext } from "@tutti-os/infra/di";
import { AnalyticsDebugFloatingEntryGate } from "@renderer/features/analytics-debug";
import { AppUpdateStatus } from "@renderer/features/app-update";
import { useTranslation } from "../../../i18n";
import { Toast } from "../../../lib/toast";
import { createWorkspaceWindowContainer } from "./createWorkspaceWindowContainer";
import { createDeferredWorkspaceContainerDispose } from "./deferredWorkspaceContainerDispose";

const LazyWorkspaceWorkbench = lazy(() =>
  import("@renderer/features/workspace-workbench/ui/WorkspaceWorkbench.tsx").then(
    (module) => ({ default: module.WorkspaceWorkbench })
  )
);
const LazyStandaloneAgentWorkbench = lazy(() =>
  import("@renderer/features/workspace-workbench/ui/StandaloneAgentWorkbench.tsx").then(
    (module) => ({ default: module.StandaloneAgentWorkbench })
  )
);

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
      <Suspense fallback={<main className="h-screen min-h-0 bg-background" />}>
        {routeView === "agent" ? (
          <LazyStandaloneAgentWorkbench
            agentProviderStatusService={agentProviderStatusService}
            desktopApi={desktopApi}
            enableWindowCloseGuard={environmentMode === "desktop"}
            hostWindowApi={hostWindowApi}
            reporterService={reporterService}
            richTextAtService={richTextAtService}
            tuttidClient={tuttidClient}
            workspaceAgentActivityService={workspaceAgentActivityService}
            workspaceAppCenterService={workspaceAppCenterService}
            workspaceID={workspaceID}
            workspaceUserProjectService={workspaceUserProjectService}
          />
        ) : (
          <LazyWorkspaceWorkbench
            enableWindowCloseGuard={environmentMode === "desktop"}
            headerSlot={<AppUpdateStatus />}
            workspaceAppExternalApi={workspaceAppExternalApi}
            workspaceID={workspaceID}
          />
        )}
      </Suspense>
      <AnalyticsDebugFloatingEntryGate />
    </InstantiationContext>
  );
}
