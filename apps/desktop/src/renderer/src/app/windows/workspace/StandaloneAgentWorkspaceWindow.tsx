import { StandaloneAgentWorkbench } from "@renderer/features/workspace-workbench/ui/StandaloneAgentWorkbench.tsx";
import { WorkspaceWindowContainerHost } from "./WorkspaceWindowContainerHost.tsx";

export function StandaloneAgentWorkspaceWindow() {
  return (
    <WorkspaceWindowContainerHost>
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
