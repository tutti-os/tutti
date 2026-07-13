import type { DesktopFusionWindowDescriptor } from "../../shared/contracts/fusion.ts";

export interface FusionWindowLoadMetadata {
  launchPayload: unknown;
  resourceID: string | null;
  windowInstanceID: string;
}

/** Native identity plus an opaque renderer-owned launch value. */
export function createFusionWindowLoadMetadata(
  descriptor: DesktopFusionWindowDescriptor,
  launchPayload: unknown
): FusionWindowLoadMetadata {
  return {
    launchPayload,
    resourceID: descriptor.resourceId,
    windowInstanceID: descriptor.windowInstanceId
  };
}
