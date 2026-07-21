import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import type { WorkspaceModelPlanProtocol } from "./workspaceSettingsTypes";

/**
 * Maps an Agent provider (Harness) to the wire protocol its compatible model
 * plans must speak. Providers without a native model-plan protocol return
 * null, which leaves plan selection unrestricted.
 */
export function modelPlanProtocolForAgentProvider(
  provider: string
): WorkspaceModelPlanProtocol | null {
  return (
    resolveAgentGUIProviderCatalogIdentity(provider)?.modelPlanProtocol || null
  );
}
