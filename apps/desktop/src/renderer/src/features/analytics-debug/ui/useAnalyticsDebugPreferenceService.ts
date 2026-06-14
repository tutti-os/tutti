import { useService } from "@tutti-os/infra/di";
import { useSnapshot } from "valtio";
import { IAnalyticsDebugPreferenceService } from "../services/analyticsDebugPreferenceService.interface";

export function useAnalyticsDebugPreferenceService() {
  const service = useService(IAnalyticsDebugPreferenceService);
  const state = useSnapshot(service.store);

  return {
    service,
    state
  };
}
