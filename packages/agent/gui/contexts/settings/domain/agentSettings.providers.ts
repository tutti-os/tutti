export const AGENT_PROVIDERS = [
  "claude-code",
  "codex",
  "cursor",
  "tutti-agent",
  "nexight",
  "opencode",
  "gemini",
  "openclaw",
  "hermes"
] as const;
export const EXPERIMENTAL_AGENT_PROVIDERS = [] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export function isValidProvider(value: unknown): value is AgentProvider {
  return (
    typeof value === "string" &&
    AGENT_PROVIDERS.includes(value as AgentProvider)
  );
}

export function normalizeAgentProviderOrder(value: unknown): AgentProvider[] {
  if (!Array.isArray(value)) {
    return [...AGENT_PROVIDERS];
  }

  const normalized: AgentProvider[] = [];
  const seen = new Set<AgentProvider>();

  for (const item of value) {
    if (!isValidProvider(item)) {
      continue;
    }

    if (seen.has(item)) {
      continue;
    }

    seen.add(item);
    normalized.push(item);
  }

  for (const provider of AGENT_PROVIDERS) {
    if (seen.has(provider)) {
      continue;
    }

    seen.add(provider);
    normalized.push(provider);
  }

  return normalized;
}
