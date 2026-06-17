import { isTuttiExternalAtProviderId } from "@tutti-os/workspace-external-core/core";
import type {
  TuttiExternalAtInsertResult,
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
  return {
    providerId,
    itemId: match.key,
    label: match.label,
    ...(match.subtitle ? { subtitle: match.subtitle } : {}),
    ...(match.thumbnailUrl ? { thumbnailUrl: match.thumbnailUrl } : {}),
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
            ? { presentation: { ...mention.presentation } }
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
