import { useEffect, useMemo } from "react";
import { InstantiationContext } from "@tutti-os/infra/di";
import { AnalyticsDebugFloatingEntryGate } from "@renderer/features/analytics-debug";
import { AppUpdateStatus } from "@renderer/features/app-update";
import { WorkspaceWorkbench } from "@renderer/features/workspace-workbench";
import { createWorkspaceWindowContainer } from "./createWorkspaceWindowContainer";
import { createDeferredWorkspaceContainerDispose } from "./deferredWorkspaceContainerDispose";

export function WorkspaceWindow() {
  const { container, environmentMode, startupWorkspaceID } = useMemo(
    () => createWorkspaceWindowContainer(),
    []
  );
  const containerDispose = useMemo(
    () => createDeferredWorkspaceContainerDispose(() => container.dispose()),
    [container]
  );
  const initialSearch = window.location.search;
  const searchParams = new URLSearchParams(initialSearch);
  const routeView = searchParams.get("view") || "workspace";
  const requestedWorkspaceID = searchParams.get("workspaceId");
  const workspaceID = requestedWorkspaceID || startupWorkspaceID;

  useEffect(() => {
    containerDispose.cancel();
    return () => {
      containerDispose.schedule();
    };
  }, [containerDispose]);

  return (
    <InstantiationContext instantiationService={container}>
      <WorkspaceWorkbench
        enableWindowCloseGuard={environmentMode === "desktop"}
        headerSlot={<AppUpdateStatus />}
        routeView={routeView}
        workspaceID={workspaceID}
      />
      <AnalyticsDebugFloatingEntryGate />
    </InstantiationContext>
  );
}
