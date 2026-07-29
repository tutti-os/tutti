import type { AgentActivityCapabilityReference } from "./types.ts";

export function normalizeAgentActivityCapabilityReferences(
  references: readonly AgentActivityCapabilityReference[] | null | undefined
): readonly AgentActivityCapabilityReference[] {
  if (!references?.length) return [];
  const seen = new Set<string>();
  const normalized: AgentActivityCapabilityReference[] = [];
  for (const reference of references) {
    const capability = reference.capability.trim();
    if (capability !== "tutti" || reference.source !== "slash_command")
      continue;
    const key = `${reference.source}:${capability}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ capability: "tutti", source: "slash_command" });
  }
  return normalized;
}
