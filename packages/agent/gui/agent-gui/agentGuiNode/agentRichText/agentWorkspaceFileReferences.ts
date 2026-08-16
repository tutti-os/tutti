import type { JSONContent } from "@tiptap/core";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import {
  mentionItemToAttrs,
  type AgentContextMentionItem
} from "./agentFileMentionExtension";
import {
  basenameFromPath,
  dirnameFromPath,
  hasPathTrailingSeparator
} from "./agentMentionMarkdown";
import { AGENT_RICH_TEXT_CARET_ANCHOR } from "./agentRichTextCaretAnchor";

function referenceMentionPath(item: WorkspaceFileReference): string {
  const path = item.path.trim();
  if (
    item.kind === "folder" &&
    path &&
    path !== "/" &&
    !hasPathTrailingSeparator(path)
  ) {
    return `${path}/`;
  }
  return path;
}

/**
 * 把任意 mention item(file / workspace-reference / …)建成可插入的节点内容。
 * 每个 item 走 mentionItemToAttrs 归一为节点 attrs;item 之间补空格。
 */
export function createAgentMentionContent(
  items: readonly AgentContextMentionItem[],
  options: { prefixCaretAnchor?: boolean } = {}
): JSONContent[] {
  return items.flatMap((item, index) => [
    ...(index === 0 && options.prefixCaretAnchor
      ? ([
          { type: "text", text: AGENT_RICH_TEXT_CARET_ANCHOR }
        ] as JSONContent[])
      : index > 0
        ? ([{ type: "text", text: " " }] as JSONContent[])
        : []),
    { type: "agentFileMention", attrs: mentionItemToAttrs(item) },
    { type: "text", text: " " }
  ]);
}

export function createAgentFileMentionContent(
  items: readonly WorkspaceFileReference[],
  options: { prefixCaretAnchor?: boolean } = {}
): JSONContent[] {
  return items.flatMap((item, index) => {
    const path = referenceMentionPath(item);
    const name = item.displayName?.trim() || basenameFromPath(path);
    return [
      ...(index === 0 && options.prefixCaretAnchor
        ? ([
            { type: "text", text: AGENT_RICH_TEXT_CARET_ANCHOR }
          ] as JSONContent[])
        : []),
      {
        type: "agentFileMention",
        attrs: {
          kind: "file",
          href: path,
          path,
          name,
          entryKind: item.kind === "folder" ? "directory" : "file",
          directoryPath: dirnameFromPath(path) || (path ? "/" : "")
        }
      },
      { type: "text", text: " " }
    ];
  });
}
