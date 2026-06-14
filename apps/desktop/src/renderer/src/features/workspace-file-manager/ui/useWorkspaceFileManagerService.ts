import { useService } from "@tutti-os/infra/di";
import { IWorkspaceFileManagerService } from "../services/workspaceFileManagerService.interface";

export function useWorkspaceFileManagerService() {
  return useService(IWorkspaceFileManagerService);
}
