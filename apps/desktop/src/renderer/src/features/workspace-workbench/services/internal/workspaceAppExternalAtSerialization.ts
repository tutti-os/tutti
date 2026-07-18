import { isTuttiExternalAtProviderId } from "@tutti-os/workspace-external-core/core";
import type {
  TuttiExternalAtInsertResult,
  TuttiExternalAtMentionPresentation,
  TuttiExternalAtQueryResult
} from "@tutti-os/workspace-external-core/contracts";
import type {
  RichTextTriggerInsertResult,
  RichTextTriggerQueryMatch
} from "@tutti-os/ui-rich-text/types";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import { workspaceAppExternalAgentIconDataUrlsByIconKey } from "./workspaceAppExternalAgentIconDataUrls.ts";

export function serializeWorkspaceAppExternalAtMatch(
  match: RichTextTriggerQueryMatch
): TuttiExternalAtQueryResult | null {
  if (!isTuttiExternalAtProviderId(match.providerId)) {
    return null;
  }
  const insert = (() => {
    switch (match.insertResult.kind) {
      case "mention": {
        const mention = match.insertResult.mention;
        return {
          kind: "mention" as const,
          mention: {
            entityId: mention.entityId,
            label: mention.label,
            ...(mention.scope ? { scope: { ...mention.scope } } : {}),
            ...(mention.presentation
              ? {
                  presentation: serializeWorkspaceAppExternalAtPresentation(
                    mention.presentation
                  )
                }
              : {})
          }
        };
      }
      case "markdown-link":
        return {
          kind: "markdown-link" as const,
          label: match.insertResult.label,
          href: match.insertResult.href
        };
      case "text":
        return {
          kind: "text" as const,
          text: match.insertResult.text
        };
      default:
        return null;
    }
  })();
  if (!insert) {
    return null;
  }
  const itemId = resolveWorkspaceAppExternalAtItemId(match, insert);
  const thumbnailUrl = serializeWorkspaceAppExternalAtIconUrl(
    match.iconUrl,
    match.insertResult
  );
  return {
    providerId: match.providerId,
    itemId,
    label: match.label,
    ...(match.subtitle ? { subtitle: match.subtitle } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    insert
  };
}

function resolveWorkspaceAppExternalAtItemId(
  match: RichTextTriggerQueryMatch,
  insert: TuttiExternalAtInsertResult
): string {
  if (insert.kind === "mention") {
    return insert.mention.entityId;
  }
  return match.key;
}

function serializeWorkspaceAppExternalAtPresentation(
  presentation: NonNullable<
    Extract<
      RichTextTriggerInsertResult,
      { kind: "mention" }
    >["mention"]["presentation"]
  >
): TuttiExternalAtMentionPresentation {
  const {
    agentIconUrl: _agentIconUrl,
    thumbnailUrl: _thumbnailUrl,
    ...canonicalPresentation
  } = presentation;
  const iconUrl = serializeWorkspaceAppExternalAtPresentationIconUrl(
    presentation.iconUrl ??
      presentation.thumbnailUrl ??
      presentation.agentIconUrl,
    presentation.agentProviderId
  );
  return {
    ...canonicalPresentation,
    ...(iconUrl ? { iconUrl } : {})
  };
}

function serializeWorkspaceAppExternalAtIconUrl(
  iconUrl: string | null | undefined,
  insertResult: RichTextTriggerInsertResult
): string {
  const agentProviderId =
    insertResult.kind === "mention"
      ? insertResult.mention.presentation?.agentProviderId
      : undefined;
  return serializeWorkspaceAppExternalAtPresentationIconUrl(
    iconUrl,
    agentProviderId
  );
}

function serializeWorkspaceAppExternalAtPresentationIconUrl(
  iconUrl: string | null | undefined,
  agentProviderId: string | null | undefined
): string {
  const normalizedIconUrl = iconUrl?.trim() ?? "";
  if (!normalizedIconUrl.startsWith("file:")) {
    return normalizedIconUrl;
  }
  const iconKey =
    resolveAgentGUIProviderCatalogIdentity(agentProviderId)?.iconKey ?? "";
  return (
    workspaceAppExternalAgentIconDataUrlsByIconKey[iconKey] ?? normalizedIconUrl
  );
}
