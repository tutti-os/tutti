import { useEffect, type JSX } from "react";
import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { cn } from "../app/renderer/lib/utils";
import { plainTextToAgentRichTextDoc } from "../agent-gui/agentGuiNode/agentRichText/agentRichTextDocument";
import { createAgentRichTextReadonlyExtensions } from "../agent-gui/agentGuiNode/agentRichText/agentRichTextExtensions";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "./AgentMessageMarkdown";
import type { AgentGUIProviderSkillOption } from "../agent-gui/agentGuiNode/model/agentGuiNodeTypes";

const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];

interface AgentRichTextReadonlyProps {
  value: string;
  className?: string;
  editorClassName?: string;
  onLinkClick?: (href: string) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
}

export function AgentRichTextReadonly({
  value,
  className,
  editorClassName,
  onLinkClick,
  availableSkills = [],
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS
}: AgentRichTextReadonlyProps): JSX.Element {
  "use memo";
  const contentDoc = plainTextToAgentRichTextDocWithWorkspaceAppIcons(
    value,
    availableSkills,
    workspaceAppIcons
  );
  const isMentionOnly = isMentionOnlyRichTextDoc(contentDoc);
  const editor = useEditor({
    immediatelyRender: false,
    editable: false,
    extensions: createAgentRichTextReadonlyExtensions({
      skills: availableSkills
    }),
    content: contentDoc,
    editorProps: {
      attributes: {
        class: cn(
          editorClassName,
          "max-w-full overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] [&_p]:m-0 [&_p]:min-h-[1.45em] [&_a[data-agent-file-mention=true]]:cursor-pointer [&_[data-agent-file-mention=true]]:overflow-hidden"
        )
      },
      handleDOMEvents: {
        click: (_view, event) => {
          if (!onLinkClick || !(event.target instanceof Element)) {
            return false;
          }
          const mention = event.target.closest(
            '[data-agent-file-mention="true"]'
          );
          if (!(mention instanceof HTMLElement)) {
            return false;
          }
          const href =
            mention instanceof HTMLAnchorElement
              ? mention.getAttribute("href") || ""
              : mention.getAttribute("data-agent-mention-href") || "";
          if (!href) {
            return false;
          }
          event.preventDefault();
          event.stopPropagation();
          onLinkClick(href);
          return true;
        }
      }
    }
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    const nextDoc = plainTextToAgentRichTextDocWithWorkspaceAppIcons(
      value,
      availableSkills,
      workspaceAppIcons
    );
    if (JSON.stringify(editor.getJSON()) === JSON.stringify(nextDoc)) {
      return;
    }
    editor.commands.setContent(nextDoc, { emitUpdate: false });
  }, [availableSkills, editor, value, workspaceAppIcons]);

  if (!editor) {
    return (
      <div
        className={className}
        data-agent-mention-only={isMentionOnly ? "true" : undefined}
      />
    );
  }

  return (
    <div
      className={className}
      data-agent-mention-only={isMentionOnly ? "true" : undefined}
    >
      <EditorContent editor={editor} />
    </div>
  );
}

function isMentionOnlyRichTextDoc(doc: JSONContent): boolean {
  if (doc.type !== "doc") {
    return false;
  }
  const blocks = doc.content ?? [];
  if (blocks.length !== 1) {
    return false;
  }
  const paragraph = blocks[0];
  if (paragraph?.type !== "paragraph") {
    return false;
  }
  const inlineContent = paragraph.content ?? [];
  return (
    inlineContent.length === 1 && inlineContent[0]?.type === "agentFileMention"
  );
}

function plainTextToAgentRichTextDocWithWorkspaceAppIcons(
  value: string,
  availableSkills: readonly AgentGUIProviderSkillOption[],
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[]
): JSONContent {
  const doc = plainTextToAgentRichTextDoc(value, { skills: availableSkills });
  if (workspaceAppIcons.length === 0) {
    return doc;
  }
  return hydrateWorkspaceAppMentionIcons(doc, workspaceAppIcons);
}

function hydrateWorkspaceAppMentionIcons(
  node: JSONContent,
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[]
): JSONContent {
  const nextContent = node.content?.map((child) =>
    hydrateWorkspaceAppMentionIcons(child, workspaceAppIcons)
  );
  if (node.type !== "agentFileMention") {
    return nextContent ? { ...node, content: nextContent } : node;
  }
  const attrs = node.attrs ?? {};
  const kind = typeof attrs.kind === "string" ? attrs.kind : "";
  const isWorkspaceAppMention = kind === "workspace-app";
  const isAppWorkspaceReferenceMention =
    kind === "workspace-reference" && attrs.source === "app";
  if (!isWorkspaceAppMention && !isAppWorkspaceReferenceMention) {
    return nextContent ? { ...node, content: nextContent } : node;
  }
  const workspaceId =
    typeof attrs.workspaceId === "string" ? attrs.workspaceId.trim() : "";
  const appId =
    isWorkspaceAppMention && typeof attrs.appId === "string"
      ? attrs.appId.trim()
      : typeof attrs.targetId === "string"
        ? attrs.targetId.trim()
        : "";
  const iconUrl = resolveWorkspaceAppIconUrl({
    appId,
    workspaceId,
    workspaceAppIcons
  });
  if (!iconUrl) {
    return nextContent ? { ...node, content: nextContent } : node;
  }
  return {
    ...node,
    attrs: {
      ...node.attrs,
      iconUrl
    },
    ...(nextContent ? { content: nextContent } : {})
  };
}

function resolveWorkspaceAppIconUrl(input: {
  appId: string;
  workspaceId: string;
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[];
}): string | undefined {
  if (!input.appId) {
    return undefined;
  }
  const exactMatch = input.workspaceAppIcons.find(
    (icon) =>
      icon.appId.trim() === input.appId &&
      (icon.workspaceId?.trim() ?? "") === input.workspaceId &&
      icon.iconUrl?.trim()
  );
  const fallbackMatch = input.workspaceAppIcons.find(
    (icon) => icon.appId.trim() === input.appId && icon.iconUrl?.trim()
  );
  return (
    exactMatch?.iconUrl?.trim() || fallbackMatch?.iconUrl?.trim() || undefined
  );
}
