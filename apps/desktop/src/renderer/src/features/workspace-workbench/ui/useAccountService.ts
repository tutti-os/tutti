import { useService } from "@tutti-os/infra/di";
import { useSnapshot } from "valtio";
import { IAccountService } from "../services/accountService.interface";

export function useAccountService() {
  const service = useService(IAccountService);
  const state = useSnapshot(service.store);

  return { service, state };
}
