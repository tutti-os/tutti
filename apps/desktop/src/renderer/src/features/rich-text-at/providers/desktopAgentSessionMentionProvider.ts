import {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionInsertResult,
  type AgentContextMentionProvider
} from "@tutti-os/agent-gui/context-mention-provider";
import type {
  RichTextMentionIdentity,
  RichTextMentionResolved
} from "@tutti-os/ui-rich-text/types";

export interface DesktopAgentSessionStatusView {
  /** Localized activity status label (e.g. "Working"). */
  readonly label: string;
  /** Normalized activity status preserved as `data-status` (e.g. "working"). */
  readonly dataStatus: string;
  /** Whether the activity status dot should pulse. */
  readonly pulse: boolean;
}

export interface CreateDesktopAgentSessionMentionProviderInput {
  readonly baseProvider: AgentContextMentionProvider;
  /** Resolve the rounded managed-agent icon URL for a session's provider. */
  readonly resolveAgentIconUrl: (provider: string) => string;
  /** The bundled user-avatar placeholder asset URL. */
  readonly userAvatarPlaceholderUrl: string;
  /**
   * Resolve a session's raw status into the display-ready activity status view
   * (localized label + normalized data-status + pulse), or null when there is no
   * status. Injected so the agent-app-coupled i18n/normalization stays at the
   * desktop contribution seam and this provider stays asset-free and testable.
   */
  readonly resolveStatusView: (
    status: string
  ) => DesktopAgentSessionStatusView | null;
}

/**
 * Wrap the raw desktop `agent-session` mention provider so its match meta
 * carries the SAME session visuals the agent composer renders: the rounded
 * managed-agent provider icon, the user avatar placeholder asset, the
 * "initiator & agent" participant line, and a resolved activity status badge
 * (label + data-status + pulse). issue-manager then reads these from `meta` and
 * renders the shared `renderMentionRow` session row identically to the agent.
 *
 * Asset/i18n resolution is INJECTED (the desktop contribution seam owns the
 * agent-app-coupled helpers/assets), so this module imports no agent-app assets
 * and stays unit-testable. Only `toInsertResult` is augmented; everything else
 * delegates to the base provider unchanged.
 */
export function createDesktopAgentSessionMentionProvider({
  baseProvider,
  resolveAgentIconUrl,
  userAvatarPlaceholderUrl,
  resolveStatusView
}: CreateDesktopAgentSessionMentionProviderInput): AgentContextMentionProvider {
  return {
    ...baseProvider,
    id: AGENT_CONTEXT_MENTION_PROVIDER_IDS.agentSession,
    getItemIconUrl: (item) =>
      resolveAgentSessionItemIconUrl(baseProvider.toInsertResult(item), {
        resolveAgentIconUrl,
        userAvatarPlaceholderUrl,
        resolveStatusView
      }),
    toInsertResult: (item) =>
      enrichAgentSessionInsertResult(baseProvider.toInsertResult(item), {
        resolveAgentIconUrl,
        userAvatarPlaceholderUrl,
        resolveStatusView
      }),
    ...(baseProvider.resolveMention
      ? {
          async resolveMention(identity) {
            const resolved = await Promise.resolve(
              baseProvider.resolveMention?.(identity)
            );
            return resolved
              ? enrichAgentSessionResolvedMention(identity, resolved, {
                  resolveAgentIconUrl,
                  userAvatarPlaceholderUrl,
                  resolveStatusView
                })
              : null;
          }
        }
      : {})
  };
}

function resolveAgentSessionItemIconUrl(
  insertResult: AgentContextMentionInsertResult,
  resolvers: Pick<
    CreateDesktopAgentSessionMentionProviderInput,
    "resolveAgentIconUrl" | "userAvatarPlaceholderUrl" | "resolveStatusView"
  >
): string | null {
  const enriched = enrichAgentSessionInsertResult(insertResult, resolvers);
  if (enriched.kind !== "mention") {
    return null;
  }
  return (
    enriched.mention.presentation?.agentIconUrl?.trim() ||
    enriched.mention.presentation?.iconUrl?.trim() ||
    null
  );
}

function enrichAgentSessionResolvedMention(
  identity: RichTextMentionIdentity,
  resolved: RichTextMentionResolved,
  resolvers: Pick<
    CreateDesktopAgentSessionMentionProviderInput,
    "resolveAgentIconUrl" | "userAvatarPlaceholderUrl" | "resolveStatusView"
  >
): RichTextMentionResolved {
  const label = resolved.label?.trim() || identity.label.trim();
  const sourceIdentity = identity as RichTextMentionIdentity & {
    readonly presentation?: RichTextMentionResolved["presentation"];
  };
  const insertResult = enrichAgentSessionInsertResult(
    {
      kind: "mention",
      mention: {
        entityId: identity.entityId,
        label,
        scope: identity.scope,
        presentation: {
          ...(sourceIdentity.presentation ?? {}),
          ...(resolved.presentation ?? {})
        }
      }
    },
    resolvers
  );
  if (insertResult.kind !== "mention") {
    return resolved;
  }
  return {
    ...resolved,
    label,
    presentation: insertResult.mention.presentation
  };
}

function enrichAgentSessionInsertResult(
  insertResult: AgentContextMentionInsertResult,
  resolvers: Pick<
    CreateDesktopAgentSessionMentionProviderInput,
    "resolveAgentIconUrl" | "userAvatarPlaceholderUrl" | "resolveStatusView"
  >
): AgentContextMentionInsertResult {
  if (insertResult.kind !== "mention") {
    return insertResult;
  }
  const presentation = insertResult.mention.presentation ?? {};
  const provider =
    presentation.agentProviderId?.trim() || presentation.subtitle?.trim() || "";
  const participant = presentation.participant?.trim() ?? "";
  const agentName = provider || insertResult.mention.label.trim();
  const status = presentation.status?.trim() ?? "";
  const statusView = status ? resolvers.resolveStatusView(status) : null;
  const agentIconUrl = resolvers.resolveAgentIconUrl(provider || agentName);
  return {
    ...insertResult,
    mention: {
      ...insertResult.mention,
      presentation: {
        ...presentation,
        iconUrl: presentation.iconUrl?.trim() || agentIconUrl,
        agentIconUrl,
        participant: participant || agentName,
        userAvatarPlaceholderUrl: resolvers.userAvatarPlaceholderUrl,
        ...(statusView
          ? {
              statusDataStatus: statusView.dataStatus,
              statusLabel: statusView.label,
              statusPulse: statusView.pulse ? "true" : "false"
            }
          : {})
      }
    }
  };
}
