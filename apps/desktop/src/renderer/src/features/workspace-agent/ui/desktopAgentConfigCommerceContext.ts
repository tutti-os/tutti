import type {
  AgentGUIAgent,
  AgentGUIAgentConfigMenuContext
} from "@tutti-os/agent-gui";

export function hasDesktopLocalTuttiAgent(
  agents: readonly Pick<AgentGUIAgent, "agentTargetId">[]
): boolean {
  return agents.some(
    (agent) => agent.agentTargetId.trim() === "local:tutti-agent"
  );
}

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
