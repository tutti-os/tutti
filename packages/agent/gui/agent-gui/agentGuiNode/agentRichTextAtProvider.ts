export const AGENT_GUI_MENTION_PROVIDER_IDS = {
  agentGeneratedFile: "agent-generated-file",
  agentSession: "agent-session",
  file: "file",
  workspaceApp: "workspace-app",
  workspaceIssue: "workspace-issue"
} as const;

export type AgentGUIMentionProviderId =
  (typeof AGENT_GUI_MENTION_PROVIDER_IDS)[keyof typeof AGENT_GUI_MENTION_PROVIDER_IDS];

export interface AgentRichTextAtProviderContext {
  metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentRichTextAtQueryInput {
  keyword: string;
  maxResults?: number;
  abortSignal?: AbortSignal;
  context: AgentRichTextAtProviderContext;
}

export interface AgentRichTextMentionInsert {
  entityId: string;
  label: string;
  href?: string | null;
  kind?: string | null;
  meta?: Readonly<Record<string, string>> | null;
}

export interface AgentRichTextMentionInsertResult {
  kind: "mention";
  mention: AgentRichTextMentionInsert;
}

export interface AgentRichTextMarkdownLinkInsertResult {
  kind: "markdown-link";
  label: string;
  href: string;
}

export interface AgentRichTextTextInsertResult {
  kind: "text";
  text: string;
}

export type AgentRichTextAtInsertResult =
  | AgentRichTextMentionInsertResult
  | AgentRichTextMarkdownLinkInsertResult
  | AgentRichTextTextInsertResult;

export interface AgentRichTextAtProvider<TItem = any> {
  id: string;
  query: (
    input: AgentRichTextAtQueryInput
  ) => Promise<readonly TItem[]> | readonly TItem[];
  getItemKey: (item: TItem) => string;
  getItemLabel: (item: TItem) => string;
  getItemSubtitle?: (item: TItem) => string | null | undefined;
  getItemThumbnailUrl?: (
    item: TItem
  ) => string | null | undefined | Promise<string | null | undefined>;
  toInsertResult: (item: TItem) => AgentRichTextAtInsertResult;
}
