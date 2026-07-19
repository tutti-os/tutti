import { lazy, Suspense } from "react";
import { AppUpdateStatus } from "@renderer/features/app-update";
import { WorkspaceWindowContainerHost } from "./WorkspaceWindowContainerHost.tsx";
import type { WorkspaceWindowContainerResult } from "./createWorkspaceWindowContainer.ts";

const LazyWorkspaceWorkbench = lazy(() =>
  import("@renderer/features/workspace-workbench/ui/WorkspaceWorkbench.tsx").then(
    (module) => ({ default: module.WorkspaceWorkbench })
  )
);

export function DefaultWorkspaceWindow({
  containerInput
}: {
  containerInput: WorkspaceWindowContainerResult;
}) {
  return (
    <WorkspaceWindowContainerHost containerInput={containerInput}>
      {({
        environmentMode,
        hostWindowApi,
        workspaceAppExternalApi,
        workspaceID
      }) => (
        <Suspense
          fallback={<main className="h-screen min-h-0 bg-background" />}
        >
          <LazyWorkspaceWorkbench
            enableWindowCloseGuard={environmentMode === "desktop"}
            headerSlot={<AppUpdateStatus />}
            hostWindowApi={hostWindowApi}
            workspaceAppExternalApi={workspaceAppExternalApi}
            workspaceID={workspaceID}
          />
        </Suspense>
      )}
    </WorkspaceWindowContainerHost>
  );
}
