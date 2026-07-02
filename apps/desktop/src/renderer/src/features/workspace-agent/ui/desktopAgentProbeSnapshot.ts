import type { AgentProbeSnapshot } from "@tutti-os/agent-gui";

export function mergeDesktopAgentProbeSnapshots(
  current: AgentProbeSnapshot | null | undefined,
  incoming: AgentProbeSnapshot
): AgentProbeSnapshot {
  if (
    !current ||
    current.workspaceId !== incoming.workspaceId ||
    current.roomId !== incoming.roomId
  ) {
    return incoming;
  }

  const mergedProviders = [...current.providers];
  const providerIndexes = new Map(
    mergedProviders.map((provider, index) => [provider.provider, index])
  );
  for (const provider of incoming.providers) {
    const index = providerIndexes.get(provider.provider);
    if (index === undefined) {
      providerIndexes.set(provider.provider, mergedProviders.length);
      mergedProviders.push(provider);
      continue;
    }
    mergedProviders[index] = provider;
  }

  return {
    ...incoming,
    capturedAtUnixMs: Math.max(
      current.capturedAtUnixMs,
      incoming.capturedAtUnixMs
    ),
    providers: mergedProviders
  };
}
