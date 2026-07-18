import { isWorkspaceAgentGuiPreviewProvider } from "../services/workspaceAgentProviderCatalog.ts";

/**
 * Filter the managed agent providers shown in the Agents settings tab by the
 * Preview Agents switch. Stable providers are always shown; preview providers
 * (e.g. Hermes) appear only when preview is enabled. Provider-neutral: the
 * preview predicate is data-driven, not a name check here.
 */
export function filterVisibleAgentProviders<T extends string>(
  providers: readonly T[],
  previewEnabled: boolean
): T[] {
  return providers.filter(
    (provider) =>
      previewEnabled || !isWorkspaceAgentGuiPreviewProvider(provider)
  );
}

export type AgentDeepLinkOutcome =
  | { kind: "focus"; provider: string }
  | { kind: "preview-hidden"; provider: string };

/**
 * Decide what a deep link to a provider's Agents-tab row should do. The panel
 * has already been routed to the Agents tab by the time this runs, so the only
 * branch is whether the target row is visible:
 *  - visible (panel was closed, or open on General, or open on Agents) -> focus
 *    and highlight the row;
 *  - hidden because it is a preview agent and the Preview Agents switch is off
 *    -> surface an "enable Preview Agents" hint instead of silently failing.
 * A null/blank provider yields no outcome.
 */
export function resolveAgentDeepLinkOutcome(input: {
  provider: string | null | undefined;
  previewEnabled: boolean;
  visibleProviders: readonly string[];
}): AgentDeepLinkOutcome | null {
  const provider = (input.provider ?? "").trim();
  if (provider === "") {
    return null;
  }
  if (input.visibleProviders.includes(provider)) {
    return { kind: "focus", provider };
  }
  if (!input.previewEnabled && isWorkspaceAgentGuiPreviewProvider(provider)) {
    return { kind: "preview-hidden", provider };
  }
  // Unknown/non-managed provider: nothing to focus, and it is not a hidden
  // preview agent, so there is no actionable hint.
  return null;
}
