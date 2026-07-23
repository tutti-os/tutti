import { useService } from "@tutti-os/infra/di";
import { useSnapshot } from "valtio";
import { IMobileRemoteAccessService } from "../services/mobileRemoteAccessService.interface";

export function useMobileRemoteAccessService() {
  const service = useService(IMobileRemoteAccessService);
  const state = useSnapshot(service.store);
  return { service, state };
}
