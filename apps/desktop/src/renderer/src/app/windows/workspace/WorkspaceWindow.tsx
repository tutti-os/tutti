import { useEffect, useMemo } from "react";
import { InstantiationContext } from "@tutti-os/infra/di";
import { AnalyticsDebugFloatingEntryGate } from "@renderer/features/analytics-debug";
import { AppUpdateStatus } from "@renderer/features/app-update";
import { WorkspaceWorkbench } from "@renderer/features/workspace-workbench";
import { createWorkspaceWindowContainer } from "./createWorkspaceWindowContainer";

export function WorkspaceWindow() {
  const { container, environmentMode, startupWorkspaceID } = useMemo(
    () => createWorkspaceWindowContainer(),
    []
  );
  const initialSearch = window.location.search;
  const searchParams = new URLSearchParams(initialSearch);
  const routeView = searchParams.get("view") || "workspace";
  const requestedWorkspaceID = searchParams.get("workspaceId");
  const workspaceID = requestedWorkspaceID || startupWorkspaceID;

  useEffect(() => {
    return () => {
      container.dispose();
    };
  }, [container]);

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
