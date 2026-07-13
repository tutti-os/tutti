import {
  createRichTextLinkMarkdown,
  createRichTextMarkdownLink,
  createRichTextMentionHref,
  createRichTextMentionMarkdown,
  isRichTextMentionHref,
  parseRichTextMentionHref
} from "@tutti-os/ui-rich-text/core";
import { getAgentCustomMentionKind } from "../../../shared/agentCustomMentionKinds";
import { translate } from "../../../i18n/index";
import type {
  AgentContextMentionItem,
  ParsedAgentMentionMarkdown
} from "./agentFileMentionContracts";

export function dirnameFromPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return path.startsWith("/") ? "/" : "";
  }
  return `/${parts.slice(0, -1).join("/")}`;
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

export function createAgentSessionMentionHref(input: {
  agentSessionId: string;
  agentTargetId?: string | null;
  label: string;
  workspaceId: string;
}): string {
  const label = normalizeAgentSessionMarkdownLabel(input.label);
  const agentTargetId = input.agentTargetId?.trim() ?? "";
  return createRichTextMentionHref({
    providerId: "agent-session",
    entityId: input.agentSessionId,
    label,
    scope: {
      ...(agentTargetId ? { agentTargetId } : {}),
      workspaceId: input.workspaceId
    }
  });
}

export function createAgentSessionMarkdownLink(input: {
  agentSessionId: string;
  agentTargetId?: string | null;
  label: string;
  workspaceId: string;
  withAtPrefix: boolean;
}): string {
  const label = normalizeAgentSessionMarkdownLabel(input.label);
  const href = createAgentSessionMentionHref({
    agentSessionId: input.agentSessionId,
    agentTargetId: input.agentTargetId,
    label,
    workspaceId: input.workspaceId
  });
  return createRichTextMarkdownLink({
    href,
    label: input.withAtPrefix ? `@${label}` : label
  });
}

export function formatAgentMentionMarkdown(
  item: AgentContextMentionItem
): string {
  // 所有 entity(含 workspace-reference)统一序列化成单条 mention 链接。
  // workspace-reference 不再展开成文件路径——agent 拿到 URI 后经 skill+CLI 按需解析。
  if (item.kind === "file") {
    const label = item.name.trim().startsWith("@")
      ? item.name
      : `@${item.name}`;
    return createRichTextLinkMarkdown({
      kind: "file",
      name: label,
      path: item.href
    });
  }
  if (item.kind === "workspace-reference") {
    return createRichTextMentionMarkdown({
      providerId: "workspace-reference",
      entityId: item.targetId,
      label: item.name,
      scope: {
        workspaceId: item.workspaceId,
        source: item.source,
        ...(item.groupId?.trim() ? { groupId: item.groupId.trim() } : {}),
        ...(item.fileCount > 0 ? { count: String(item.fileCount) } : {})
      }
    });
  }
  if (item.kind === "session") {
    return createAgentSessionMarkdownLink({
      agentSessionId: item.targetId,
      agentTargetId:
        item.agentTargetId ?? agentSessionTargetIdFromHref(item.href),
      label: item.name,
      workspaceId: item.workspaceId,
      withAtPrefix: true
    });
  }
  if (item.kind === "agent-target") {
    return createRichTextMentionMarkdown({
      providerId: "agent-target",
      entityId: item.targetId,
      label: item.name,
      scope: { workspaceId: item.workspaceId }
    });
  }
  const identity = parseRichTextMentionHref(item.href, item.name);
  return identity ? createRichTextMentionMarkdown(identity) : "";
}

function normalizeAgentSessionMarkdownLabel(value: string): string {
  return value.trim().replace(/^@+/, "").trim();
}

export function agentSessionTargetIdFromHref(href: string): string | undefined {
  const mention = parseRichTextMentionHref(href, "");
  const agentTargetId = mention?.scope?.agentTargetId?.trim() ?? "";
  return agentTargetId || undefined;
}

export function parseMentionFileCount(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function parseAgentMentionMarkdown(
  value: string,
  start = 0
): ParsedAgentMentionMarkdown | null {
  if (!value.startsWith("[", start)) {
    return null;
  }

  let index = start + 1;
  const prefixedMention = value[index] === "@";
  if (prefixedMention) {
    index += 1;
  }
  let name = "";
  while (index < value.length) {
    const current = value[index];
    if (current === "\\") {
      const escaped = value[index + 1];
      if (escaped === "\\" || escaped === "[" || escaped === "]") {
        name += escaped;
        index += 2;
        continue;
      }
      name += current;
      index += 1;
      continue;
    }
    if (current === "]") {
      break;
    }
    name += current;
    index += 1;
  }

  if (value[index] !== "]" || value[index + 1] !== "(") {
    return null;
  }

  index += 2;
  let href = "";
  while (index < value.length) {
    const current = value[index];
    if (current === "\\") {
      const escaped = value[index + 1];
      if (escaped === "\\" || escaped === ")") {
        href += escaped;
        index += 2;
        continue;
      }
      href += current;
      index += 1;
      continue;
    }
    if (current === ")") {
      const item = parseMentionItemFromHref({ name, href });
      if (!item) {
        return null;
      }
      if (
        item.kind !== "file" &&
        !prefixedMention &&
        !isRichTextMentionHref(href)
      ) {
        return null;
      }
      return {
        item,
        end: index + 1
      };
    }
    href += current;
    index += 1;
  }

  return null;
}

export function parseMentionItemFromHref(input: {
  name: string;
  href: string;
}): AgentContextMentionItem | null {
  const href = input.href.trim();
  if (!href) {
    return null;
  }
  const mention = parseRichTextMentionHref(href, input.name);
  if (!mention && !isRichTextMentionHref(href)) {
    return {
      kind: "file",
      href,
      path: href,
      name: input.name,
      entryKind: isLocalDirectoryMentionHref(href) ? "directory" : "unknown",
      directoryPath: dirnameFromPath(href)
    };
  }
  if (!mention) {
    return null;
  }

  const resource = mention.providerId.trim().toLowerCase();
  const targetId = mention.entityId.trim();
  const workspaceId = mention.scope?.workspaceId?.trim() ?? "";
  const name = mention.label;
  if (resource === "agent-session") {
    if (!workspaceId) {
      return null;
    }
    return {
      kind: "session",
      href,
      workspaceId,
      targetId,
      agentTargetId: mention.scope?.agentTargetId?.trim() || undefined,
      name,
      title: name,
      scope: "collab_sessions",
      initiatorName: "",
      agentName: ""
    };
  }
  if (resource === "workspace-issue") {
    if (!workspaceId) {
      return null;
    }
    return {
      kind: "workspace-issue",
      href,
      workspaceId,
      targetId,
      topicId: mention.scope?.topicId?.trim() || undefined,
      name,
      title: name
    };
  }
  if (resource === "workspace-app") {
    if (!workspaceId) {
      return null;
    }
    return {
      kind: "workspace-app",
      href,
      workspaceId,
      targetId,
      appId: targetId,
      name,
      iconUrl: mention.scope?.icon?.trim() || undefined
    };
  }
  if (resource === "agent-target") {
    if (!workspaceId) {
      return null;
    }
    return {
      kind: "agent-target",
      href,
      workspaceId,
      targetId,
      name
    };
  }
  if (resource === "workspace-reference") {
    if (!workspaceId) {
      return null;
    }
    const source = mention.scope?.source?.trim();
    if (source !== "app" && source !== "task") {
      return null;
    }
    return {
      kind: "workspace-reference",
      href,
      workspaceId,
      targetId,
      source,
      groupId: mention.scope?.groupId?.trim() || undefined,
      name,
      iconUrl: mention.scope?.icon?.trim() || undefined,
      fileCount: parseMentionFileCount(mention.scope?.count)
    };
  }
  if (resource === "workspace-app-factory") {
    return {
      kind: "workspace-app-factory",
      href,
      workspaceId,
      targetId,
      jobId: targetId === "create" ? "" : targetId,
      name:
        name ||
        translate("agentHost.agentGui.workspaceAppFactoryMentionFallback"),
      action: mention.scope?.action?.trim() || undefined,
      contextPath: mention.scope?.contextPath?.trim() || undefined
    };
  }
  const customDefinition = getAgentCustomMentionKind(resource);
  if (customDefinition) {
    const presentation = customDefinition.present(mention, href);
    if (!presentation) {
      return null;
    }
    return {
      kind: "custom",
      customKind: resource,
      href,
      workspaceId: presentation.workspaceId?.trim() || workspaceId,
      targetId,
      name: presentation.name.trim() || name,
      summary: presentation.summary?.trim() || undefined
    };
  }
  return null;
}

function isLocalDirectoryMentionHref(href: string): boolean {
  return href.endsWith("/") && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href);
}
