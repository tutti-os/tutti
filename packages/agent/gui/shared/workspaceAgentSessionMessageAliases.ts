import type { AgentActivitySession } from "@tutti-os/agent-activity-core";

export function workspaceAgentSessionMessageAliases(
  session: AgentActivitySession
): string[] {
  const values = [session.agentSessionId, session.providerSessionId];
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const value of values) {
    const normalized = value?.trim() ?? "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push(normalized);
  }
  return aliases;
}
