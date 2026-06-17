import type {
  RichTextTriggerProvider,
  RichTextTriggerQueryInput
} from "@tutti-os/ui-rich-text/types";
import {
  TUTTI_EXTERNAL_AT_PROVIDER_IDS,
  type TuttiExternalAtProviderId
} from "@tutti-os/workspace-external-core/contracts";

export const AGENT_CONTEXT_MENTION_PROVIDER_IDS =
  TUTTI_EXTERNAL_AT_PROVIDER_IDS;

export type AgentContextMentionProviderId = TuttiExternalAtProviderId;

export type AgentContextMentionQueryInput = RichTextTriggerQueryInput & {
  trigger: "@";
};

export interface AgentContextMentionPresentation {
  agentProviderId?: string;
  agentIconUrl?: string;
  iconUrl?: string;
  thumbnailUrl?: string;
  subtitle?: string;
  description?: string;
  participant?: string;
  status?: string;
  statusDataStatus?: string;
  statusLabel?: string;
  statusPulse?: string;
  userAvatarPlaceholderUrl?: string;
}

export type AgentContextMentionInsertResult =
  | {
      kind: "mention";
      mention: {
        entityId: string;
        label: string;
        scope?: Readonly<Record<string, string>>;
        presentation?: AgentContextMentionPresentation;
      };
    }
  | {
      kind: "markdown-link";
      label: string;
      href: string;
    }
  | {
      kind: "text";
      text: string;
    };

export type AgentContextMentionProvider<TItem = any> = Omit<
  RichTextTriggerProvider<TItem>,
  "toInsertResult"
> & {
  trigger: "@";
  toInsertResult: (item: TItem) => AgentContextMentionInsertResult;
  getItemThumbnailUrl?: (
    item: TItem
  ) => string | null | undefined | Promise<string | null | undefined>;
};
