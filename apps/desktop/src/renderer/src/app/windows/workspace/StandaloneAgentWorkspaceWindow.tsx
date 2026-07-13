import { StandaloneAgentWorkbench } from "@renderer/features/workspace-workbench/ui/StandaloneAgentWorkbench.tsx";
import { WorkspaceWindowContainerHost } from "./WorkspaceWindowContainerHost.tsx";

export function StandaloneAgentWorkspaceWindow() {
  return (
    <WorkspaceWindowContainerHost>
      {({
        agentProviderStatusService,
        desktopApi,
        environmentMode,
        hostWindowApi,
        reporterService,
        richTextAtService,
        tuttidClient,
        workspaceAgentActivityService,
        workspaceAppCenterService,
        workspaceID,
        workspaceUserProjectService
      }) => (
        <StandaloneAgentWorkbench
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
      )}
    </WorkspaceWindowContainerHost>
  );
}
