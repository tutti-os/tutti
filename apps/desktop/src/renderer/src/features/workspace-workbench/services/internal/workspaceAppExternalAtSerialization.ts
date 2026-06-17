import { isTuttiExternalAtProviderId } from "@tutti-os/workspace-external-core/core";
import type {
  TuttiExternalAtInsertResult,
  TuttiExternalAtMentionPresentation,
  TuttiExternalAtProviderId,
  TuttiExternalAtQueryResult
} from "@tutti-os/workspace-external-core/contracts";
import type {
  RichTextTriggerInsertResult,
  RichTextTriggerQueryMatch
} from "@tutti-os/ui-rich-text/types";

export function serializeWorkspaceAppExternalAtMatch(
  match: RichTextTriggerQueryMatch
): TuttiExternalAtQueryResult | null {
  const providerId = toExternalAtProviderId(match.providerId);
  if (!providerId) {
    return null;
  }
  const insert = serializeWorkspaceAppExternalAtInsert(match.insertResult);
  if (!insert) {
    return null;
  }
  const itemId = resolveWorkspaceAppExternalAtItemId(match, insert);
  return {
    providerId,
    itemId,
    label: match.label,
    ...(match.subtitle ? { subtitle: match.subtitle } : {}),
    ...(match.iconUrl ? { thumbnailUrl: match.iconUrl } : {}),
    insert
  };
}

export function toExternalAtProviderId(
  providerId: string
): TuttiExternalAtProviderId | null {
  if (isTuttiExternalAtProviderId(providerId)) {
    return providerId;
  }
  return null;
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

export function serializeWorkspaceAppExternalAtInsert(
  insert: RichTextTriggerInsertResult
): TuttiExternalAtInsertResult | null {
  switch (insert.kind) {
    case "mention": {
      const mention = insert.mention;
      return {
        kind: "mention",
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
        kind: "markdown-link",
        label: insert.label,
        href: insert.href
      };
    case "text":
      return {
        kind: "text",
        text: insert.text
      };
    default:
      return null;
  }
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
