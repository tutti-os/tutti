import { mergeAttributes, Node, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import Suggestion, { exitSuggestion } from "@tiptap/suggestion";
import {
  buildAgentSessionMentionHref,
  buildAgentWorkspaceAppFactoryMentionHref,
  buildAgentWorkspaceAppMentionHref,
  buildAgentWorkspaceIssueMentionHref,
  parseMentionItemFromHref
} from "@tutti-os/ui-rich-text/mention";
import {
  resolveAgentMentionFileThumbnailUrl,
  resolveAgentMentionFileVisualKind
} from "../../shared/mentionFilePresentation";
import { AgentMentionNodeView } from "./AgentMentionNodeView";

export {
  buildAgentSessionMentionHref,
  buildAgentWorkspaceAppFactoryMentionHref,
  buildAgentWorkspaceAppMentionHref,
  buildAgentWorkspaceIssueMentionHref,
  parseAgentMentionMarkdown
} from "@tutti-os/ui-rich-text/mention";

export type AgentFileMentionKind = "file" | "directory" | "unknown";
export type AgentMentionFileNavigationAction =
  | "agent-generated-folder"
  | "agent-generated-folder-back";
export type AgentMentionScope = "my_sessions" | "collab_sessions";
export type AgentMentionKind =
  | "file"
  | "session"
  | "workspace-app"
  | "workspace-app-factory"
  | "workspace-issue";

export interface AgentMentionFileItem {
  kind: "file";
  path: string;
  href: string;
  name: string;
  entryKind: AgentFileMentionKind;
  directoryPath: string;
  score?: number;
  thumbnailUrl?: string | null;
  mentionNavigation?: AgentMentionFileNavigationAction;
  childCount?: number;
}

export interface AgentMentionSessionItem {
  kind: "session";
  href: string;
  workspaceId: string;
  targetId: string;
  name: string;
  title: string;
  scope: AgentMentionScope;
  initiatorName: string;
  initiatorAvatarUrl?: string;
  agentName: string;
  status?: string;
  inputPreview?: string;
  summaryPreview?: string;
  updatedAtUnixMs?: number;
}

export interface AgentMentionWorkspaceIssueItem {
  kind: "workspace-issue";
  href: string;
  workspaceId: string;
  targetId: string;
  name: string;
  title: string;
  creatorName?: string;
  status?: string;
  contentPreview?: string;
  updatedAtUnixMs?: number;
}

export interface AgentMentionWorkspaceAppItem {
  kind: "workspace-app";
  href: string;
  workspaceId: string;
  targetId: string;
  appId: string;
  name: string;
  description?: string;
  iconUrl?: string;
}

export interface AgentMentionWorkspaceAppFactoryItem {
  kind: "workspace-app-factory";
  href: string;
  workspaceId: string;
  targetId: string;
  jobId: string;
  name: string;
  action?: string;
  contextPath?: string;
}

export type AgentContextMentionItem =
  | AgentMentionFileItem
  | AgentMentionSessionItem
  | AgentMentionWorkspaceAppItem
  | AgentMentionWorkspaceAppFactoryItem
  | AgentMentionWorkspaceIssueItem;

export type AgentFileMentionItem = AgentContextMentionItem;

export interface AgentMentionSuggestionState {
  editor: Editor;
  range: Range;
  query: string;
  text: string;
  command: (item: AgentContextMentionItem) => void;
  clientRect?: (() => DOMRect | null) | null;
}

export type AgentFileMentionSuggestionState = AgentMentionSuggestionState;

export interface AgentFileMentionExtensionOptions {
  enableSuggestions?: boolean;
  onSuggestionChange?: (state: AgentMentionSuggestionState | null) => void;
  onSuggestionKeyDown?: (event: KeyboardEvent) => boolean;
  removeActionAriaLabel?: string;
  renderAsLink?: boolean;
}

export interface ParsedAgentMentionMarkdown {
  item: AgentContextMentionItem;
  end: number;
}

export const agentFileMentionPluginKey = new PluginKey(
  "agentFileMentionSuggestion"
);

export function exitAgentFileMentionSuggestion(editor: Editor): void {
  exitSuggestion(editor.view, agentFileMentionPluginKey);
}

export function createAgentFileMentionExtension(
  options: AgentFileMentionExtensionOptions = {}
): Node {
  return Node.create({
    name: "agentFileMention",
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,

    addOptions() {
      return options;
    },

    addAttributes() {
      return {
        name: { default: "" },
        kind: { default: "file" },
        href: { default: "" },
        path: { default: "" },
        entryKind: { default: "unknown" },
        directoryPath: { default: "" },
        workspaceId: { default: "" },
        targetId: { default: "" },
        scope: { default: "" },
        title: { default: "" },
        initiatorName: { default: "" },
        agentName: { default: "" },
        status: { default: "" },
        inputPreview: { default: "" },
        summaryPreview: { default: "" },
        creatorName: { default: "" },
        appId: { default: "" },
        jobId: { default: "" },
        action: { default: "" },
        contextPath: { default: "" },
        description: { default: "" },
        iconUrl: { default: "" },
        contentPreview: { default: "" },
        thumbnailUrl: { default: "" }
      };
    },

    parseHTML() {
      return [
        {
          tag: "span[data-agent-file-mention]",
          getAttrs: parseAgentMentionHTMLElementAttrs
        },
        {
          tag: "a[data-agent-file-mention]",
          getAttrs: parseAgentMentionHTMLElementAttrs
        }
      ];
    },

    renderHTML({ HTMLAttributes }) {
      const item = attrsToMentionItem(HTMLAttributes);
      const fileThumbnailUrl =
        item.kind === "file"
          ? resolveAgentMentionFileThumbnailUrl(item)
          : undefined;
      const href = item.href;
      const tagName = options.renderAsLink ? "a" : "span";
      const visual = mentionVisual(item);
      const sessionVisual =
        item.kind === "session" ? sessionMentionVisual(item) : null;
      const sharedAttributes = {
        "data-agent-file-mention": "true",
        "data-agent-mention-href": href,
        "data-agent-mention-kind": item.kind,
        "aria-label":
          item.kind === "file"
            ? visual.primary
            : `${visual.kindLabel} ${visual.primary}`.trim()
      };
      return [
        tagName,
        mergeAttributes(HTMLAttributes, {
          ...sharedAttributes,
          ...(item.kind === "file"
            ? {
                "data-agent-file-entry-kind": item.entryKind,
                "data-agent-file-directory-path": item.directoryPath,
                "data-agent-file-visual-kind":
                  resolveAgentMentionFileVisualKind(item)
              }
            : {}),
          ...(options.renderAsLink ? { href } : {}),
          ...(item.kind === "workspace-app" && item.iconUrl
            ? { "data-agent-mention-icon-url": item.iconUrl }
            : {}),
          ...(fileThumbnailUrl
            ? { "data-agent-mention-thumbnail-url": fileThumbnailUrl }
            : {}),
          class:
            item.kind === "file"
              ? "tsh-agent-object-token tsh-agent-object-token--file"
              : "tsh-agent-object-token tsh-agent-object-token--entity"
        }),
        ...(item.kind === "file"
          ? [
              fileThumbnailUrl
                ? [
                    "span",
                    {
                      class: "agent-gui-node__mention-file-thumb",
                      "data-agent-mention-file-thumb": "true",
                      "aria-hidden": "true"
                    },
                    [
                      "img",
                      {
                        src: fileThumbnailUrl,
                        alt: "",
                        decoding: "async",
                        loading: "lazy",
                        draggable: "false"
                      }
                    ]
                  ]
                : [
                    "span",
                    {
                      class: "tsh-agent-object-token__icon",
                      "aria-hidden": "true"
                    },
                    ""
                  ],
              [
                "span",
                { class: "tsh-agent-object-token__main" },
                visual.primary
              ]
            ]
          : item.kind === "session"
            ? [
                [
                  "span",
                  {
                    class: "tsh-agent-object-token__kind",
                    "aria-hidden": "true"
                  },
                  [
                    "span",
                    {
                      class: "tsh-agent-object-token__kind-icon",
                      "aria-hidden": "true"
                    },
                    ""
                  ]
                ],
                [
                  "span",
                  { class: "tsh-agent-object-token__main" },
                  [
                    "span",
                    { class: "tsh-agent-object-token__participant" },
                    sessionVisual?.participant ?? ""
                  ],
                  [
                    "span",
                    { class: "tsh-agent-object-token__summary" },
                    sessionVisual?.summary ? ` ${sessionVisual.summary}` : ""
                  ]
                ]
              ]
            : [
                [
                  "span",
                  {
                    class: "tsh-agent-object-token__kind",
                    "aria-hidden": "true"
                  },
                  [
                    "span",
                    {
                      class: "tsh-agent-object-token__kind-icon",
                      "aria-hidden": "true"
                    },
                    ""
                  ]
                ],
                [
                  "span",
                  { class: "tsh-agent-object-token__main" },
                  visual.primary
                ]
              ])
      ];
    },

    renderText({ node }) {
      return formatAgentMentionMarkdown(attrsToMentionItem(node.attrs ?? {}));
    },

    addNodeView() {
      return ReactNodeViewRenderer(AgentMentionNodeView);
    },

    addProseMirrorPlugins() {
      if (options.enableSuggestions === false) {
        return [];
      }
      return [
        Suggestion<AgentContextMentionItem, AgentContextMentionItem>({
          editor: this.editor,
          pluginKey: agentFileMentionPluginKey,
          char: "@",
          allowedPrefixes: [" ", "\n", "\t"],
          allowSpaces: true,
          items: () => [],
          allow: ({ state, range }) => {
            if (range.from <= 1) {
              return true;
            }
            const previous = state.doc.textBetween(
              range.from - 1,
              range.from,
              "\n",
              "\n"
            );
            return previous === " " || previous === "\n" || previous === "\t";
          },
          command: ({ editor, range, props }) => {
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                {
                  type: this.name,
                  attrs: mentionItemToAttrs(props)
                },
                { type: "text", text: " " }
              ])
              .run();
          },
          render: () => ({
            onStart: (props) => {
              options.onSuggestionChange?.({
                editor: props.editor,
                range: props.range,
                query: props.query,
                text: props.text,
                command: props.command,
                clientRect: props.clientRect
              });
            },
            onUpdate: (props) => {
              options.onSuggestionChange?.({
                editor: props.editor,
                range: props.range,
                query: props.query,
                text: props.text,
                command: props.command,
                clientRect: props.clientRect
              });
            },
            onExit: () => {
              options.onSuggestionChange?.(null);
            },
            onKeyDown: (props) =>
              options.onSuggestionKeyDown?.(props.event) ?? false
          })
        })
      ];
    }
  });
}

export function normalizeAgentSessionMentionTitle(value: string): string {
  const trimmed = value.trim();
  const withoutMentionPrefix = trimmed.replace(/^@+/, "").trim();
  return withoutMentionPrefix || trimmed;
}

export function formatAgentFileMentionMarkdown(
  name: string,
  path: string
): string {
  return formatAgentMentionMarkdown({
    kind: "file",
    href: path,
    path,
    name,
    entryKind: "unknown",
    directoryPath: ""
  });
}

export function formatAgentMentionMarkdown(
  item: AgentContextMentionItem
): string {
  const labelPrefix = "@";
  return `[${labelPrefix}${escapeMarkdownLinkLabel(item.name)}](${escapeMarkdownLinkTarget(item.href)})`;
}

function mentionItemToAttrs(
  item: AgentContextMentionItem
): Record<string, string> {
  if (item.kind === "file") {
    return {
      name: item.name,
      kind: item.kind,
      href: item.href,
      path: item.path,
      entryKind: item.entryKind,
      directoryPath: item.directoryPath,
      thumbnailUrl: resolveAgentMentionFileThumbnailUrl(item) ?? ""
    };
  }
  if (item.kind === "session") {
    return {
      name: item.name,
      kind: item.kind,
      href: item.href,
      ...workspaceMentionAttrs(item.workspaceId),
      targetId: item.targetId,
      scope: item.scope,
      title: item.title,
      initiatorName: item.initiatorName,
      agentName: item.agentName,
      status: item.status ?? "",
      inputPreview: item.inputPreview ?? "",
      summaryPreview: item.summaryPreview ?? ""
    };
  }
  if (item.kind === "workspace-app") {
    return {
      name: item.name,
      kind: item.kind,
      href: item.href,
      ...workspaceMentionAttrs(item.workspaceId),
      targetId: item.targetId,
      appId: item.appId,
      description: item.description ?? "",
      iconUrl: item.iconUrl ?? ""
    };
  }
  if (item.kind === "workspace-app-factory") {
    return {
      name: item.name,
      kind: item.kind,
      href: item.href,
      ...workspaceMentionAttrs(item.workspaceId),
      targetId: item.targetId,
      jobId: item.jobId,
      action: item.action ?? "",
      contextPath: item.contextPath ?? ""
    };
  }
  return {
    name: item.name,
    kind: item.kind,
    href: item.href,
    ...workspaceMentionAttrs(item.workspaceId),
    targetId: item.targetId,
    title: item.title,
    creatorName: item.creatorName ?? "",
    status: item.status ?? "",
    contentPreview: item.contentPreview ?? ""
  };
}

function workspaceMentionAttrs(
  workspaceId: string
): Pick<AgentMentionSessionItem, "workspaceId"> {
  const normalizedWorkspaceId = workspaceId.trim();
  return {
    workspaceId: normalizedWorkspaceId
  };
}

export function attrsToMentionItem(
  attrs: Record<string, unknown>
): AgentContextMentionItem {
  const kind = normalizeMentionKind(attrs.kind);
  const name = typeof attrs.name === "string" ? attrs.name : "";
  const href =
    typeof attrs.href === "string" && attrs.href.trim() ? attrs.href : "";
  if (kind === "session") {
    const workspaceId = workspaceIdFromMentionAttrs(attrs);
    const targetId = typeof attrs.targetId === "string" ? attrs.targetId : "";
    return {
      kind,
      href: href || buildAgentSessionMentionHref(workspaceId, targetId),
      workspaceId,
      targetId,
      name,
      title:
        typeof attrs.title === "string" && attrs.title.trim()
          ? attrs.title
          : name,
      scope:
        attrs.scope === "my_sessions" || attrs.scope === "collab_sessions"
          ? attrs.scope
          : "collab_sessions",
      initiatorName:
        typeof attrs.initiatorName === "string" ? attrs.initiatorName : "",
      agentName: typeof attrs.agentName === "string" ? attrs.agentName : "",
      status: typeof attrs.status === "string" ? attrs.status : undefined,
      inputPreview:
        typeof attrs.inputPreview === "string" ? attrs.inputPreview : undefined,
      summaryPreview:
        typeof attrs.summaryPreview === "string"
          ? attrs.summaryPreview
          : undefined
    };
  }
  if (kind === "workspace-issue") {
    const workspaceId = workspaceIdFromMentionAttrs(attrs);
    const targetId = typeof attrs.targetId === "string" ? attrs.targetId : "";
    return {
      kind,
      href: href || buildAgentWorkspaceIssueMentionHref(workspaceId, targetId),
      workspaceId,
      targetId,
      name,
      title:
        typeof attrs.title === "string" && attrs.title.trim()
          ? attrs.title
          : name,
      creatorName:
        typeof attrs.creatorName === "string" ? attrs.creatorName : undefined,
      status: typeof attrs.status === "string" ? attrs.status : undefined,
      contentPreview:
        typeof attrs.contentPreview === "string"
          ? attrs.contentPreview
          : undefined
    };
  }
  if (kind === "workspace-app") {
    const workspaceId = workspaceIdFromMentionAttrs(attrs);
    const appId =
      typeof attrs.appId === "string" && attrs.appId.trim()
        ? attrs.appId.trim()
        : typeof attrs.targetId === "string"
          ? attrs.targetId.trim()
          : "";
    return {
      kind,
      href: href || buildAgentWorkspaceAppMentionHref(workspaceId, appId),
      workspaceId,
      targetId: appId,
      appId,
      name,
      description:
        typeof attrs.description === "string" ? attrs.description : undefined,
      iconUrl:
        typeof attrs.iconUrl === "string" && attrs.iconUrl.trim()
          ? attrs.iconUrl.trim()
          : undefined
    };
  }
  if (kind === "workspace-app-factory") {
    const workspaceId = workspaceIdFromMentionAttrs(attrs);
    const jobId =
      typeof attrs.jobId === "string" && attrs.jobId.trim()
        ? attrs.jobId.trim()
        : typeof attrs.targetId === "string"
          ? attrs.targetId.trim()
          : "";
    const action =
      typeof attrs.action === "string" && attrs.action.trim()
        ? attrs.action.trim()
        : undefined;
    const contextPath =
      typeof attrs.contextPath === "string" && attrs.contextPath.trim()
        ? attrs.contextPath.trim()
        : undefined;
    return {
      kind,
      href:
        href ||
        buildAgentWorkspaceAppFactoryMentionHref(workspaceId, jobId, {
          action,
          contextPath
        }),
      workspaceId,
      targetId: jobId,
      jobId,
      name,
      action,
      contextPath
    };
  }
  const path =
    typeof attrs.path === "string" && attrs.path.trim()
      ? attrs.path
      : typeof attrs.href === "string"
        ? attrs.href
        : "";
  return {
    kind: "file",
    href: href || path,
    path,
    name,
    entryKind: normalizeEntryKind(attrs.entryKind),
    directoryPath:
      typeof attrs.directoryPath === "string" && attrs.directoryPath.trim()
        ? attrs.directoryPath
        : dirnameFromPath(path),
    thumbnailUrl: resolveAgentMentionFileThumbnailUrl({
      entryKind: normalizeEntryKind(attrs.entryKind),
      href: href || path,
      name,
      path,
      thumbnailUrl:
        typeof attrs.thumbnailUrl === "string" ? attrs.thumbnailUrl : undefined
    })
  };
}

function workspaceIdFromMentionAttrs(attrs: Record<string, unknown>): string {
  return typeof attrs.workspaceId === "string" ? attrs.workspaceId.trim() : "";
}

function parseAgentMentionHTMLElementAttrs(
  node: HTMLElement | string
): Record<string, string> | false {
  if (typeof node === "string") {
    return false;
  }
  const href =
    node.getAttribute("data-agent-mention-href") ||
    node.getAttribute("data-agent-link-href") ||
    node.getAttribute("href") ||
    "";
  const name =
    node.getAttribute("name") ||
    (node.textContent ?? "").replace(/^@+/, "").trim();
  const parsedItem = href ? parseMentionItemFromHref({ name, href }) : null;
  const parsedAttrs = parsedItem ? mentionItemToAttrs(parsedItem) : {};
  const iconUrl = node.getAttribute("data-agent-mention-icon-url") || "";
  return {
    ...parsedAttrs,
    name,
    kind:
      node.getAttribute("data-agent-mention-kind") ||
      node.getAttribute("kind") ||
      parsedAttrs.kind ||
      "file",
    href,
    ...(iconUrl ? { iconUrl } : {})
  };
}

function normalizeMentionKind(value: unknown): AgentMentionKind {
  if (value === "session" || value === "agent-session") {
    return "session";
  }
  if (value === "workspace-issue") {
    return "workspace-issue";
  }
  if (value === "workspace-app") {
    return "workspace-app";
  }
  if (value === "workspace-app-factory") {
    return "workspace-app-factory";
  }
  return "file";
}

function normalizeEntryKind(value: unknown): AgentFileMentionKind {
  return value === "directory" || value === "file" ? value : "unknown";
}

function mentionVisual(item: AgentContextMentionItem): {
  kindLabel: string;
  primary: string;
} {
  if (item.kind === "file") {
    return {
      kindLabel: "File",
      primary: item.name
    };
  }
  if (item.kind === "session") {
    const visual = sessionMentionVisual(item);
    return {
      kindLabel: "Session",
      primary: `${visual.participant} ${visual.summary}`.trim()
    };
  }
  if (item.kind === "workspace-app") {
    return {
      kindLabel: "App",
      primary: item.name
    };
  }
  if (item.kind === "workspace-app-factory") {
    return {
      kindLabel: "App Factory",
      primary: item.name
    };
  }
  return {
    kindLabel: "Issue",
    primary: item.name
  };
}

function sessionMentionVisual(
  item: Extract<AgentContextMentionItem, { kind: "session" }>
): {
  participant: string;
  summary: string;
} {
  const initiatorName = item.initiatorName.trim();
  const agentName = item.agentName.trim();
  const title = normalizeAgentSessionMentionTitle(item.title);
  if (initiatorName && agentName) {
    const dottedTitle = parseDottedSessionMentionText(title);
    return {
      participant: `${initiatorName} & ${agentName}`,
      summary:
        dottedTitle?.summary ||
        (title && title !== item.name.trim()
          ? title
          : item.inputPreview?.trim() || "")
    };
  }

  const dottedName = parseDottedSessionMentionText(item.name);
  if (dottedName) {
    return {
      participant: dottedName.participant,
      summary: dottedName.summary
    };
  }

  return {
    participant: item.name.trim(),
    summary:
      title && title !== item.name.trim()
        ? title
        : item.inputPreview?.trim() || ""
  };
}

function parseDottedSessionMentionText(
  value: string
): { participant: string; summary: string } | null {
  const parts = value
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  return {
    participant: `${parts[0]} & ${parts[1]}`,
    summary: normalizeAgentSessionMentionTitle(parts.slice(2).join(" "))
  };
}

function dirnameFromPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return path.startsWith("/") ? "/" : "";
  }
  return `/${parts.slice(0, -1).join("/")}`;
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function escapeMarkdownLinkTarget(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}
