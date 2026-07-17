import { translate } from "../../i18n/index";
import type { AgentContextMentionItem } from "./agentRichText/agentFileMentionExtension";
import type { AgentMentionFileItem } from "./agentRichText/agentFileMentionExtension";

const AGENT_GENERATED_FOLDER_MIN_FILES = 2;

export function presentAgentGeneratedFileMentionItems(input: {
  files: readonly AgentContextMentionItem[];
  browsePath: string | null;
  query: string;
}): AgentContextMentionItem[] {
  const fileItems = input.files.filter(
    (item): item is AgentMentionFileItem => item.kind === "file"
  );
  if (input.query.trim()) {
    return fileItems;
  }
  if (input.browsePath) {
    return presentAgentGeneratedBrowseFolder(fileItems, input.browsePath);
  }
  return presentAgentGeneratedRootFolders(fileItems);
}

function presentAgentGeneratedRootFolders(
  files: readonly AgentMentionFileItem[]
): AgentMentionFileItem[] {
  const filesByDirectory = new Map<string, AgentMentionFileItem[]>();
  for (const file of files) {
    const directoryPath = resolveAgentGeneratedFileDirectoryPath(file);
    const group = filesByDirectory.get(directoryPath);
    if (group) {
      group.push(file);
      continue;
    }
    filesByDirectory.set(directoryPath, [file]);
  }

  const presented: AgentMentionFileItem[] = [];
  for (const [directoryPath, group] of filesByDirectory) {
    if (group.length >= AGENT_GENERATED_FOLDER_MIN_FILES) {
      presented.push(createAgentGeneratedFolderItem(directoryPath, group));
      continue;
    }
    presented.push(...group);
  }

  return sortAgentGeneratedMentionItems(presented);
}

function presentAgentGeneratedBrowseFolder(
  files: readonly AgentMentionFileItem[],
  browsePath: string
): AgentMentionFileItem[] {
  const normalizedBrowsePath = normalizeAgentGeneratedDirectoryPath(browsePath);
  const children = files.filter(
    (file) =>
      resolveAgentGeneratedFileDirectoryPath(file) === normalizedBrowsePath
  );
  return [
    createAgentGeneratedFolderBackItem(normalizedBrowsePath),
    ...sortAgentGeneratedMentionItems(children)
  ];
}

function createAgentGeneratedFolderItem(
  directoryPath: string,
  files: readonly AgentMentionFileItem[]
): AgentMentionFileItem {
  const normalizedPath = normalizeAgentGeneratedDirectoryPath(directoryPath);
  const name =
    normalizedPath.split("/").filter(Boolean).at(-1) ?? normalizedPath;
  return {
    kind: "file",
    href: `${normalizedPath}/`,
    path: normalizedPath,
    name,
    entryKind: "directory",
    directoryPath: parentAgentGeneratedDirectoryPath(normalizedPath),
    mentionNavigation: "agent-generated-folder",
    childCount: files.length
  };
}

function createAgentGeneratedFolderBackItem(
  browsePath: string
): AgentMentionFileItem {
  return {
    kind: "file",
    href: "",
    path: browsePath,
    name: translate("agentHost.agentGui.mentionFolderBack"),
    entryKind: "unknown",
    directoryPath: parentAgentGeneratedDirectoryPath(browsePath),
    mentionNavigation: "agent-generated-folder-back"
  };
}

function resolveAgentGeneratedFileDirectoryPath(
  file: AgentMentionFileItem
): string {
  const directoryPath = file.directoryPath?.trim();
  if (directoryPath) {
    return normalizeAgentGeneratedDirectoryPath(directoryPath);
  }
  return parentAgentGeneratedDirectoryPath(file.path);
}

function parentAgentGeneratedDirectoryPath(path: string): string {
  const normalized = normalizeAgentGeneratedDirectoryPath(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}

function normalizeAgentGeneratedDirectoryPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function sortAgentGeneratedMentionItems(
  items: readonly AgentMentionFileItem[]
): AgentMentionFileItem[] {
  return [...items].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );
}

export function agentGeneratedMentionItemKey(
  item: AgentContextMentionItem
): string {
  if (item.kind !== "file") {
    return item.targetId;
  }
  if (item.mentionNavigation) {
    return `${item.mentionNavigation}:${item.path}`;
  }
  return item.path;
}
