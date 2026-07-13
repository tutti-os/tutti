import type { AgentGUIProvider } from "./types.ts";
import { migratedAgentGUIProviderIdentityCatalog } from "./providerIdentityCatalog.ts";
import { createProviderIconUrlMap } from "./providerIconAssets.ts";

export const agentGuiDockIconUrls = createDockIconUrls();

export const agentGuiDockIconUrl = agentGuiDockIconUrls.codex;

function createDockIconUrls(): Record<AgentGUIProvider, string> {
  return createProviderIconUrlMap(
    "dock",
    {},
    migratedAgentGUIProviderIdentityCatalog
  ) as Record<AgentGUIProvider, string>;
}
