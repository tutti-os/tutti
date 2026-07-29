import type {
  AppCenterAuthoringCapabilities,
  AppCenterHostActions
} from "../ui/AppCard.tsx";

export interface ResolvedAppCenterAuthoringCapabilities {
  readonly createApp: boolean;
  readonly importArchive: boolean;
  readonly loadUnpacked: boolean;
}

export function resolveAppCenterAuthoringCapabilities(
  capabilities: AppCenterAuthoringCapabilities | undefined,
  actions: AppCenterHostActions
): ResolvedAppCenterAuthoringCapabilities {
  return {
    createApp:
      capabilities?.createApp === true &&
      typeof actions.createFactoryJob === "function",
    importArchive:
      capabilities?.importArchive === true &&
      typeof actions.importApp === "function",
    loadUnpacked:
      capabilities?.loadUnpacked === true &&
      typeof actions.loadLocalApp === "function"
  };
}
