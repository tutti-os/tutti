import { translate } from "../../i18n/index";
import type {
  AgentContextMentionItem,
  AgentMentionFileItem
} from "./agentRichText/agentFileMentionExtension";

export function presentWorkspaceFileDirectoryMentionItems(input: {
  browsePath: string;
  items: readonly AgentContextMentionItem[];
}): AgentContextMentionItem[] {
  return [createWorkspaceFileFolderBackItem(input.browsePath), ...input.items];
}

function createWorkspaceFileFolderBackItem(
  browsePath: string
): AgentMentionFileItem {
  return {
    kind: "file",
    href: "",
    path: browsePath,
    name: translate("agentHost.agentGui.mentionFolderBack"),
    entryKind: "unknown",
    directoryPath: parentWorkspaceFileDirectoryPath(browsePath),
    mentionNavigation: "workspace-folder-back"
  };
}

function parentWorkspaceFileDirectoryPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}
