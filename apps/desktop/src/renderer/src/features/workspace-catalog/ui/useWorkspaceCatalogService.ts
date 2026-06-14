import { useService } from "@tutti-os/infra/di";
import { useSnapshot } from "valtio";
import { IWorkspaceCatalogService } from "../services/workspaceCatalogService.interface";

export function useWorkspaceCatalogService() {
  const service = useService(IWorkspaceCatalogService);
  const state = useSnapshot(service.store);

  return {
    service,
    state
  };
}
