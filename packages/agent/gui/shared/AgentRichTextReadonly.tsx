import { useMemo, type JSX, type MouseEvent } from "react";
import type { JSONContent } from "@tiptap/core";
import { renderToReactElement } from "@tiptap/static-renderer";
import { cn } from "../app/renderer/lib/utils";
import { plainTextToAgentRichTextDoc } from "../agent-gui/agentGuiNode/agentRichText/agentRichTextDocument";
import { AGENT_RICH_TEXT_CARET_ANCHOR } from "../agent-gui/agentGuiNode/agentRichText/agentRichTextCaretAnchor";
import { createAgentRichTextReadonlyExtensions } from "../agent-gui/agentGuiNode/agentRichText/agentRichTextExtensions";
import { AgentMentionReadonlyView } from "../agent-gui/agentGuiNode/agentRichText/AgentMentionNodeView";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "./AgentMessageMarkdown";
import type { AgentGUIProviderSkillOption } from "../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import {
  resolveAgentTargetPresentation,
  useAgentTargetPresentations,
  type AgentMessageMarkdownAgentTarget
} from "./AgentTargetPresentationContext";

const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];
const EMPTY_SKILLS: readonly AgentGUIProviderSkillOption[] = [];

interface AgentRichTextReadonlyProps {
  value: string;
  className?: string;
  editorClassName?: string;
  onLinkClick?: (href: string) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  agentTargets?: readonly AgentMessageMarkdownAgentTarget[];
}

export function AgentRichTextReadonly({
  value,
  className,
  editorClassName,
  onLinkClick,
  availableSkills = EMPTY_SKILLS,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS,
  agentTargets
}: AgentRichTextReadonlyProps): JSX.Element {
  "use memo";
  const contextAgentTargets = useAgentTargetPresentations();
  const effectiveAgentTargets = agentTargets ?? contextAgentTargets;
  const contentDoc = useMemo(
    () =>
      plainTextToAgentRichTextDocWithMentionPresentations(
        value,
        availableSkills,
        workspaceAppIcons,
        effectiveAgentTargets
      ),
    [availableSkills, effectiveAgentTargets, value, workspaceAppIcons]
  );
  const isMentionOnly = isMentionOnlyRichTextDoc(contentDoc);
  const extensions = useMemo(
    () =>
      createAgentRichTextReadonlyExtensions({
        skills: availableSkills
      }),
    [availableSkills]
  );
  const renderedContent = useMemo(
    () =>
      renderToReactElement({
        content: contentDoc,
        extensions,
        options: {
          nodeMapping: {
            agentFileMention: ({ node }) => (
              <AgentMentionReadonlyView attrs={node.attrs ?? {}} />
            )
          }
        }
      }),
    [contentDoc, extensions]
  );

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onLinkClick || !(event.target instanceof Element)) {
      return;
    }
    const mention = event.target.closest('[data-agent-file-mention="true"]');
    if (!(mention instanceof HTMLElement)) {
      return;
    }
    const href = mention.getAttribute("data-agent-mention-href") || "";
    if (!href) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onLinkClick(href);
  };

  return (
    <div
      className={className}
      data-agent-mention-only={isMentionOnly ? "true" : undefined}
    >
      <div
        className={cn(
          "tiptap ProseMirror",
          editorClassName,
          "max-w-full overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] [&_p]:m-0 [&_p]:min-h-[1.45em] [&_a[data-agent-file-mention=true]]:cursor-pointer [&_[data-agent-file-mention=true]]:overflow-hidden"
        )}
        onClick={handleClick}
      >
        {renderedContent}
      </div>
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
  const inlineContent = (paragraph.content ?? []).filter(
    (node) =>
      !(
        node.type === "text" &&
        (node.text ?? "").replaceAll(AGENT_RICH_TEXT_CARET_ANCHOR, "")
          .length === 0
      )
  );
  return (
    inlineContent.length === 1 && inlineContent[0]?.type === "agentFileMention"
  );
}

function plainTextToAgentRichTextDocWithMentionPresentations(
  value: string,
  availableSkills: readonly AgentGUIProviderSkillOption[],
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[],
  agentTargets: readonly AgentMessageMarkdownAgentTarget[]
): JSONContent {
  let doc = plainTextToAgentRichTextDoc(value, { skills: availableSkills });
  if (workspaceAppIcons.length > 0) {
    doc = hydrateWorkspaceAppMentionIcons(doc, workspaceAppIcons);
  }
  if (agentTargets.length > 0) {
    doc = hydrateAgentMentionPresentations(doc, agentTargets);
  }
  return doc;
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

function hydrateAgentMentionPresentations(
  node: JSONContent,
  agentTargets: readonly AgentMessageMarkdownAgentTarget[]
): JSONContent {
  const nextContent = node.content?.map((child) =>
    hydrateAgentMentionPresentations(child, agentTargets)
  );
  if (node.type !== "agentFileMention") {
    return nextContent ? { ...node, content: nextContent } : node;
  }
  const attrs = node.attrs ?? {};
  const kind = typeof attrs.kind === "string" ? attrs.kind : "";
  if (kind !== "agent-target" && kind !== "session") {
    return nextContent ? { ...node, content: nextContent } : node;
  }
  const agentTargetId =
    kind === "session"
      ? typeof attrs.agentTargetId === "string"
        ? attrs.agentTargetId.trim()
        : ""
      : typeof attrs.targetId === "string"
        ? attrs.targetId.trim()
        : "";
  const workspaceId =
    typeof attrs.workspaceId === "string" ? attrs.workspaceId.trim() : "";
  const target = resolveAgentTargetPresentation({
    agentTargetId,
    agentTargets,
    workspaceId
  });
  if (!target) {
    return nextContent ? { ...node, content: nextContent } : node;
  }
  return {
    ...node,
    attrs: {
      ...node.attrs,
      agentProviderId: target.provider?.trim() ?? "",
      iconUrl: target.iconUrl?.trim() ?? "",
      ...(kind === "agent-target"
        ? { name: target.name?.trim() || attrs.name }
        : {})
    },
    ...(nextContent ? { content: nextContent } : {})
  };
}
