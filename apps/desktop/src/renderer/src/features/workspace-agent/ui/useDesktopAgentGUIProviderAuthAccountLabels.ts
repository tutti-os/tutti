import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import { useMemo } from "react";
import { resolveDesktopAgentGUIProviderAuthAccountLabels } from "./desktopAgentGUIWorkbenchStateHelpers.ts";

export function useDesktopAgentGUIProviderAuthAccountLabels(
  statuses: readonly AgentProviderStatus[]
) {
  return useMemo(
    () => resolveDesktopAgentGUIProviderAuthAccountLabels(statuses),
    [statuses]
  );
}
