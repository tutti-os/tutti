import type { CustomScheme } from "electron";
import { tuttiAssetProtocolScheme } from "../../shared/tuttiAssetProtocol.ts";
import { workspaceFileIconProtocolScheme } from "./workspaceFileIconCacheStore.ts";

export const desktopCustomProtocolSchemes = [
  {
    privileges: {
      corsEnabled: true,
      secure: true,
      standard: true,
      supportFetchAPI: true
    },
    scheme: tuttiAssetProtocolScheme
  },
  {
    privileges: {
      corsEnabled: true,
      secure: true,
      standard: true,
      supportFetchAPI: true
    },
    scheme: workspaceFileIconProtocolScheme
  }
] satisfies CustomScheme[];
