import type {
  AgentActivityRuntime,
  AgentQueuedPromptRuntime
} from "@tutti-os/agent-gui";
import { createAgentQueuedPromptRuntime } from "@tutti-os/agent-gui/queued-prompt-runtime";
import type { DesktopHostFilesApi, DesktopRuntimeApi } from "@preload/types";
import type { IReporterService } from "@renderer/features/analytics";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/index.ts";
import { createDesktopAgentActivityRuntime } from "../createDesktopAgentActivityRuntime.ts";
import type { IWorkspaceAgentActivityService } from "../workspaceAgentActivityService.interface";
import { createDesktopAgentQueuedPromptDrainCoordinator } from "./createDesktopAgentQueuedPromptDrainCoordinator.ts";

export interface DesktopAgentActivityRuntimeServices {
  agentActivityRuntime: AgentActivityRuntime;
  agentQueuedPromptRuntime: AgentQueuedPromptRuntime;
  queuedPromptDrainCoordinatorDispose: () => void;
}

export interface GetDesktopAgentActivityRuntimeServicesInput {
  hostFilesApi: DesktopHostFilesApi;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  runtimeApi: DesktopRuntimeApi;
  warmupOpenclawGateway?: NonNullable<
    AgentActivityRuntime["warmupOpenclawGateway"]
  >;
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
      warmupOpenclawGateway: input.warmupOpenclawGateway,
      workspaceUserProjectService: input.workspaceUserProjectService
    }
  );
  const agentQueuedPromptRuntime = createAgentQueuedPromptRuntime();
  const queuedPromptDrainCoordinatorDispose =
    createDesktopAgentQueuedPromptDrainCoordinator({
      agentActivityRuntime,
      agentQueuedPromptRuntime,
      workspaceId: input.workspaceId
    });
  const services: DesktopAgentActivityRuntimeServices = {
    agentActivityRuntime,
    agentQueuedPromptRuntime,
    queuedPromptDrainCoordinatorDispose
  };
  servicesByWorkspace.set(workspaceKey, services);
  return services;
}
