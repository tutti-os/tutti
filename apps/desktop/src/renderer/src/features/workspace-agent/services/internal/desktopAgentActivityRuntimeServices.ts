import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import type { DesktopHostFilesApi, DesktopRuntimeApi } from "@preload/types";
import type { IReporterService } from "@renderer/features/analytics";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/index.ts";
import { createDesktopAgentActivityRuntime } from "../createDesktopAgentActivityRuntime.ts";
import type { IWorkspaceAgentActivityService } from "../workspaceAgentActivityService.interface";

export interface DesktopAgentActivityRuntimeServices {
  agentActivityRuntime: AgentActivityRuntime;
}

export interface GetDesktopAgentActivityRuntimeServicesInput {
  hostFilesApi: DesktopHostFilesApi;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  runtimeApi: DesktopRuntimeApi;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceId: string;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
}

const runtimeServicesByActivityService = new WeakMap<
  IWorkspaceAgentActivityService,
  Map<string, DesktopAgentActivityRuntimeServices>
>();

export function getDesktopAgentActivityRuntimeServices(
  input: GetDesktopAgentActivityRuntimeServicesInput
): DesktopAgentActivityRuntimeServices {
  const workspaceKey = input.workspaceId.trim();
  let servicesByWorkspace = runtimeServicesByActivityService.get(
    input.workspaceAgentActivityService
  );
  if (!servicesByWorkspace) {
    servicesByWorkspace = new Map();
    runtimeServicesByActivityService.set(
      input.workspaceAgentActivityService,
      servicesByWorkspace
    );
  }
  const existing = servicesByWorkspace.get(workspaceKey);
  if (existing) {
    return existing;
  }
  const agentActivityRuntime = createDesktopAgentActivityRuntime(
    input.workspaceAgentActivityService,
    {
      reporterNow: input.reporterNow,
      reporterService: input.reporterService,
      hostFilesApi: input.hostFilesApi,
      runtimeApi: input.runtimeApi,
      workspaceUserProjectService: input.workspaceUserProjectService
    }
  );
  const services: DesktopAgentActivityRuntimeServices = {
    agentActivityRuntime
  };
  servicesByWorkspace.set(workspaceKey, services);
  return services;
}
