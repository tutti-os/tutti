export function resolveStandaloneAgentBrowserSessionId(input: {
  currentAgentSessionId: string | null;
  resourceAgentSessionId?: string | null;
}): string | null {
  return input.resourceAgentSessionId ?? input.currentAgentSessionId;
}
