import type { AgentGUIAgentConfigMenuContext } from "@tutti-os/agent-gui";

export function isDesktopLocalTuttiAgentConfigContext(
  context: AgentGUIAgentConfigMenuContext
): boolean {
  return (
    context.ownership === "self" &&
    context.agentTargetId.trim() === "local:tutti-agent"
  );
}

export function shouldRenderDesktopAgentConfigCommerce(input: {
  context: AgentGUIAgentConfigMenuContext;
  enabled: boolean;
  hasAccount: boolean;
}): boolean {
  return (
    input.enabled &&
    input.hasAccount &&
    isDesktopLocalTuttiAgentConfigContext(input.context)
  );
}
