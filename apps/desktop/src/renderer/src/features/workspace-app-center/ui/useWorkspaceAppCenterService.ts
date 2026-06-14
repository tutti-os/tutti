import { useService } from "@tutti-os/infra/di";
import { useSnapshot } from "valtio";
import { IWorkspaceAppCenterService } from "../services/workspaceAppCenterService.interface";

export function useWorkspaceAppCenterService() {
  const service = useService(IWorkspaceAppCenterService);
  const state = useSnapshot(service.store);

  return {
    service,
    state
  };
}
