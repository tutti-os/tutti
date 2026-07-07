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
  return {
    providerId: match.providerId,
    itemId,
    label: match.label,
    ...(match.subtitle ? { subtitle: match.subtitle } : {}),
    ...(match.iconUrl ? { thumbnailUrl: match.iconUrl } : {}),
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
  const iconUrl = presentation.iconUrl?.trim() ?? "";
  const thumbnailUrl = presentation.thumbnailUrl?.trim() || iconUrl;
  return {
    ...presentation,
    ...(thumbnailUrl ? { thumbnailUrl } : {})
  };
}
