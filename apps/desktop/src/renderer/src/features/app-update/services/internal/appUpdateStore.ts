import { proxy } from "valtio";
import type { AppUpdateStoreState } from "../appUpdateTypes";
import { resolveAppUpdateViewState } from "./appUpdateViewModel.ts";

export function createAppUpdateStore(
  supportsReleaseChannels = true
): AppUpdateStoreState {
  return proxy({
    error: null,
    isActing: false,
    supportsReleaseChannels,
    updateState: null,
    view: resolveAppUpdateViewState(null)
  });
}
