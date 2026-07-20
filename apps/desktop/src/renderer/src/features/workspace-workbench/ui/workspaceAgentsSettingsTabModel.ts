import { isWorkspaceAgentGuiEarlyAccessProvider } from "../services/workspaceAgentProviderCatalog.ts";

/**
 * Filter the managed agent providers shown in the Agents settings tab by the
 * Early Access integrations switch. Stable providers are always shown;
 * early-access providers appear only when the switch is enabled.
 */
export function filterVisibleAgentProviders<T extends string>(
  providers: readonly T[],
  earlyAccessEnabled: boolean
): T[] {
  return providers.filter(
    (provider) =>
      earlyAccessEnabled || !isWorkspaceAgentGuiEarlyAccessProvider(provider)
  );
}

export type AgentDeepLinkOutcome =
  | { kind: "focus"; provider: string }
  | { kind: "early-access-hidden"; provider: string };

/**
 * Decide what a deep link to a provider's Agents-tab row should do. The panel
 * has already been routed to the Agents tab by the time this runs, so the only
 * branch is whether the target row is visible:
 *  - visible (panel was closed, or open on General, or open on Agents) -> focus
 *    and highlight the row;
 *  - hidden because its Tutti integration is Early Access and the gate is off
 *    -> surface an enable hint instead of silently failing.
 * A null/blank provider yields no outcome.
 */
export function resolveAgentDeepLinkOutcome(input: {
  provider: string | null | undefined;
  earlyAccessEnabled: boolean;
  visibleProviders: readonly string[];
}): AgentDeepLinkOutcome | null {
  const provider = (input.provider ?? "").trim();
  if (provider === "") {
    return null;
  }
  if (input.visibleProviders.includes(provider)) {
    return { kind: "focus", provider };
  }
  if (
    !input.earlyAccessEnabled &&
    isWorkspaceAgentGuiEarlyAccessProvider(provider)
  ) {
    return { kind: "early-access-hidden", provider };
  }
  // Unknown/non-managed provider: nothing to focus, and it is not a hidden
  // early-access integration, so there is no actionable hint.
  return null;
}
