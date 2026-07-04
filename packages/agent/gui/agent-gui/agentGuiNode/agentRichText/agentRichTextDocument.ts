import type { Editor, JSONContent } from "@tiptap/core";
import {
  attrsToMentionItem,
  formatAgentMentionMarkdown,
  mentionItemToAttrs,
  parseAgentMentionMarkdown
} from "./agentFileMentionExtension";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import { parseAgentSkillToken } from "./agentSkillTokenExtension";
import {
  parseAgentCapabilityToken,
  type AgentCapabilityTokenOption
} from "./agentCapabilityTokenExtension";
import { AGENT_RICH_TEXT_CARET_ANCHOR } from "./agentRichTextCaretAnchor";

export interface AgentRichTextDocumentOptions {
  capabilities?: readonly AgentCapabilityTokenOption[];
  skills?: readonly AgentGUIProviderSkillOption[];
}

function createEmptyDocument(): JSONContent {
  return {
    type: "doc",
    content: [{ type: "paragraph" }]
  };
}

function isVisualLineStart(content: readonly JSONContent[]): boolean {
  return content.length === 0 || content.at(-1)?.type === "hardBreak";
}

function createParagraphFromText(
  text: string,
  options: AgentRichTextDocumentOptions = {}
): JSONContent {
  const content: JSONContent[] = [];
  let index = 0;
  let textBuffer = "";

  const flushTextBuffer = (): void => {
    if (textBuffer.length === 0) {
      return;
    }
    content.push({ type: "text", text: textBuffer });
    textBuffer = "";
  };

  while (index < text.length) {
    const current = text[index];
    if (current === "\n") {
      flushTextBuffer();
      content.push({ type: "hardBreak" });
      index += 1;
      continue;
    }

    const parsedMention = parseAgentMentionMarkdown(text, index);
    if (parsedMention) {
      flushTextBuffer();
      if (isVisualLineStart(content)) {
        content.push({ type: "text", text: AGENT_RICH_TEXT_CARET_ANCHOR });
      }
      content.push({
        type: "agentFileMention",
        // 转成规范 node attrs(如 workspace-reference 的 source/groupId/fileCount),
        // 否则只读回显里的 reference chip 拿不到文件数 → 不显示「N 个文件」角标。
        attrs: mentionItemToAttrs(parsedMention.item)
      });
      index = parsedMention.end;
      continue;
    }

    const parsedCapabilityToken = parseAgentCapabilityToken(
      text,
      index,
      options.capabilities
    );
    if (parsedCapabilityToken) {
      flushTextBuffer();
      content.push({
        type: "agentCapabilityToken",
        attrs: parsedCapabilityToken.attrs
      });
      index = parsedCapabilityToken.end;
      continue;
    }

    const parsedSkillToken = parseAgentSkillToken(text, index, options.skills);
    if (parsedSkillToken) {
      flushTextBuffer();
      content.push({
        type: "agentSkillToken",
        attrs: parsedSkillToken.attrs
      });
      index = parsedSkillToken.end;
      continue;
    }

    textBuffer += current;
    index += 1;
  }

  flushTextBuffer();
  return content.length > 0
    ? { type: "paragraph", content }
    : { type: "paragraph" };
}

export function plainTextToAgentRichTextDoc(
  text: string,
  options: AgentRichTextDocumentOptions = {}
): JSONContent {
  if (text.length === 0) {
    return createEmptyDocument();
  }
  const normalized = text.replace(/\r\n?/g, "\n");
  return {
    type: "doc",
    content: [createParagraphFromText(normalized, options)]
  };
}

export function plainTextToAgentRichTextInlineContent(
  text: string,
  options: AgentRichTextDocumentOptions = {}
): JSONContent[] {
  const paragraph = createParagraphFromText(
    text.replace(/\r\n?/g, "\n"),
    options
  );
  return paragraph.content ?? [];
}

export function agentRichTextDocToPromptText(doc: JSONContent): string {
  if (doc.type !== "doc") {
    return nodeToPromptText(doc);
  }
  return agentRichTextContentToPromptText(doc.content ?? []);
}

export function editorToPromptText(editor: Editor): string {
  return agentRichTextDocToPromptText(editor.getJSON());
}

export function agentRichTextContentToPromptText(
  content: readonly JSONContent[]
): string {
  if (content.length === 0) {
    return "";
  }
  const separator = content.some((node) => isBlockPromptNode(node)) ? "\n" : "";
  return content.map((node) => nodeToPromptText(node)).join(separator);
}

function isBlockPromptNode(node: JSONContent): boolean {
  return node.type === "doc" || node.type === "paragraph";
}

function nodeToPromptText(node: JSONContent): string {
  if (node.type === "text") {
    return (node.text ?? "").replaceAll(AGENT_RICH_TEXT_CARET_ANCHOR, "");
  }
  if (node.type === "agentFileMention") {
    return formatAgentMentionMarkdown(attrsToMentionItem(node.attrs ?? {}));
  }
  if (node.type === "agentSkillToken") {
    return typeof node.attrs?.trigger === "string" ? node.attrs.trigger : "";
  }
  if (node.type === "agentCapabilityToken") {
    return typeof node.attrs?.trigger === "string" ? node.attrs.trigger : "";
  }
  if (node.type === "hardBreak") {
    return "\n";
  }
  if (!node.content || node.content.length === 0) {
    return "";
  }
  return node.content.map((child) => nodeToPromptText(child)).join("");
}
