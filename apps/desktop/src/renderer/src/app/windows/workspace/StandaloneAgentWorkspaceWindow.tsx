import { StandaloneAgentWorkbench } from "@renderer/features/workspace-workbench/ui/StandaloneAgentWorkbench.tsx";
import { WorkspaceWindowContainerHost } from "./WorkspaceWindowContainerHost.tsx";
import type { WorkspaceWindowContainerResult } from "./createWorkspaceWindowContainer.ts";

export function StandaloneAgentWorkspaceWindow({
  containerInput
}: {
  containerInput: WorkspaceWindowContainerResult;
}) {
  return (
    <WorkspaceWindowContainerHost containerInput={containerInput}>
      {({
        agentProviderStatusService,
        desktopApi,
        environmentMode,
        eventStreamClient,
        hostWindowApi,
        reporterService,
        richTextAtService,
        tuttidClient,
        workspaceAgentActivityService,
        workspaceAppCenterService,
        workspaceAppExternalApi,
        workspaceID,
        workspaceUserProjectService
      }) => (
        <StandaloneAgentWorkbench
          agentProviderStatusService={agentProviderStatusService}
          desktopApi={desktopApi}
          enableWindowCloseGuard={environmentMode === "desktop"}
          eventStreamClient={eventStreamClient}
          hostWindowApi={hostWindowApi}
          reporterService={reporterService}
          richTextAtService={richTextAtService}
          tuttidClient={tuttidClient}
          workspaceAgentActivityService={workspaceAgentActivityService}
          workspaceAppCenterService={workspaceAppCenterService}
          workspaceAppExternalApi={workspaceAppExternalApi}
          workspaceID={workspaceID}
          workspaceUserProjectService={workspaceUserProjectService}
        />
      )}
    </WorkspaceWindowContainerHost>
  );
}
