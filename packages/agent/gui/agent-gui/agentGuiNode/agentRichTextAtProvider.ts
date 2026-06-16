import type {
  RichTextAtInsertResult,
  RichTextAtProvider,
  RichTextAtProviderContext,
  RichTextAtQueryInput,
  RichTextAtReferenceItem,
  RichTextAtReferenceItemsResponse,
  RichTextAtReferenceItemsResult,
  RichTextMarkdownLinkInsertResult,
  RichTextMentionAtInsertResult,
  RichTextMentionInsert,
  RichTextTextInsertResult
} from "@tutti-os/ui-rich-text/types";

export const AGENT_GUI_MENTION_PROVIDER_IDS = {
  agentGeneratedFile: "agent-generated-file",
  agentSession: "agent-session",
  file: "file",
  workspaceApp: "workspace-app",
  workspaceIssue: "workspace-issue"
} as const;

export type AgentGUIMentionProviderId =
  (typeof AGENT_GUI_MENTION_PROVIDER_IDS)[keyof typeof AGENT_GUI_MENTION_PROVIDER_IDS];

export type AgentRichTextAtProviderContext = RichTextAtProviderContext;
export type AgentRichTextAtQueryInput = RichTextAtQueryInput;
export type AgentRichTextMentionInsert = RichTextMentionInsert;
export type AgentRichTextMentionInsertResult = RichTextMentionAtInsertResult;
export type AgentRichTextMarkdownLinkInsertResult =
  RichTextMarkdownLinkInsertResult;
export type AgentRichTextTextInsertResult = RichTextTextInsertResult;
export type AgentRichTextAtInsertResult = RichTextAtInsertResult;
export type AgentRichTextAtReferenceItem = RichTextAtReferenceItem;
export type AgentRichTextAtReferenceItemsResult =
  RichTextAtReferenceItemsResult;
export type AgentRichTextAtReferenceItemsResponse =
  RichTextAtReferenceItemsResponse;
export type AgentRichTextAtProvider<TItem = any> = RichTextAtProvider<TItem>;
