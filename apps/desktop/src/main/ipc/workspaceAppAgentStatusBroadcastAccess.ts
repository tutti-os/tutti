import type { DesktopFusionRendererAccessContext } from "../windows/fusionWindowCoordinatorTypes.ts";

export function canBroadcastWorkspaceAppAgentStatus(input: {
  fusionActive: boolean;
  rendererAccess: DesktopFusionRendererAccessContext | null;
}): boolean {
  return !input.fusionActive || input.rendererAccess?.kind === "dock";
}
