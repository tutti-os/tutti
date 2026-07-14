import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";

/**
 * Cached provider-status snapshots can linger as not-ready after startup's
 * background catalog scan. Switching into that provider (for example Cursor)
 * would otherwise flash the AgentGUI "connect provider" notice until a later
 * refresh eventually marks it ready. Recheck once per not-ready availability
 * key and treat readiness as unknown while that recheck is pending.
 */
export function activeProviderNotReadyRecheckKey(input: {
  availabilityStatus: string | null | undefined;
  provider: WorkspaceAgentProvider;
}): string | null {
  const availability = input.availabilityStatus?.trim() || "missing";
  if (availability === "ready" || availability === "missing") {
    return null;
  }
  return `${input.provider}:${availability}`;
}

export function shouldSuppressAgentProviderNotReadyProjection(input: {
  recheckKey: string | null;
  settledRecheckKey: string | null;
}): boolean {
  return (
    input.recheckKey !== null && input.settledRecheckKey !== input.recheckKey
  );
}
