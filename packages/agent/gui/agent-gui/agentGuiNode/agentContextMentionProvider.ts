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
  /**
   * 应用是否能够提供产物文件(reference)。"true" 表示支持,缺省/其它值表示不支持。
   * 仅用于 @ 面板行末尾「查看产物文件」入口的展示判断,不持久化到 mention 节点。
   */
  referencesListSupported?: string;
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
  getItemIconUrl?: (
    item: TItem
  ) => string | null | undefined | Promise<string | null | undefined>;
};
