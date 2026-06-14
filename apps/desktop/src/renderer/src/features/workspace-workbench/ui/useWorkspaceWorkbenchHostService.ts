import { useService } from "@tutti-os/infra/di";
import { IWorkspaceWorkbenchHostService } from "../services/workspaceWorkbenchHostService.interface";

export function useWorkspaceWorkbenchHostService() {
  return useService(IWorkspaceWorkbenchHostService);
}
