import { useService } from "@tutti-os/infra/di";
import { useSnapshot } from "valtio";
import { IFusionDockService } from "./fusionDockService.interface.ts";

export function useFusionDockController() {
  const service = useService(IFusionDockService);
  const state = useSnapshot(service.store);

  return { service, state };
}
