import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "@tutti-os/agent-gui/context-mention-provider";
import type { AgentContextMentionProvider } from "@tutti-os/agent-gui/context-mention-provider";
import { resolveAgentMentionFileVisualKind } from "@tutti-os/agent-gui/mention-file-presentation";
import type { WorkbenchDockPreviewCache } from "@tutti-os/workbench-surface";
import type { WorkbenchDockFileMentionItem } from "./resolveWorkbenchDockFileMentionItems.ts";

const { file: FILE_PROVIDER_ID } = AGENT_CONTEXT_MENTION_PROVIDER_IDS;

export function wrapDesktopFileMentionProviderWithDockFiles<TItem>(
  provider: AgentContextMentionProvider<TItem>,
  options: {
    readDockPreview?: WorkbenchDockPreviewCache["read"];
    resolveDockFiles: () => readonly WorkbenchDockFileMentionItem[];
  }
): AgentContextMentionProvider<TItem> {
  if (provider.id !== FILE_PROVIDER_ID) {
    return provider;
  }

  const iconUrlByPath = new Map<string, string>();

  return {
    ...provider,
    async query(input) {
      const keyword = input.keyword.trim();
      const allDockFiles = options.resolveDockFiles();
      await hydrateDockFileThumbnails({
        dockFiles: allDockFiles,
        readDockPreview: options.readDockPreview,
        iconUrlByPath
      });

      if (!keyword) {
        return limitDockFiles(allDockFiles, input.maxResults) as unknown as
          | readonly TItem[]
          | Promise<readonly TItem[]>;
      }

      // The daemon-backed provider owns ranked search results. Dock files are
      // a browse source and thumbnail cache, not a second relevance model.
      return provider.query(input);
    },
    getItemIconUrl(item) {
      const path = provider.getItemKey(item);
      if (resolveAgentMentionFileVisualKind({ path }) !== "image") {
        return null;
      }
      return iconUrlByPath.get(path) ?? null;
    }
  };
}

async function hydrateDockFileThumbnails(input: {
  dockFiles: readonly WorkbenchDockFileMentionItem[];
  readDockPreview?: WorkbenchDockPreviewCache["read"];
  iconUrlByPath: Map<string, string>;
}): Promise<void> {
  input.iconUrlByPath.clear();
  if (!input.readDockPreview) {
    return;
  }

  await Promise.all(
    input.dockFiles
      .filter(
        (dockFile) =>
          resolveAgentMentionFileVisualKind({ path: dockFile.path }) === "image"
      )
      .map(async (dockFile) => {
        const iconUrl = await input
          .readDockPreview?.(dockFile.previewCacheKey)
          .catch(() => null);
        const normalizedIconUrl = iconUrl?.trim() ?? "";
        if (!normalizedIconUrl) {
          return;
        }
        input.iconUrlByPath.set(dockFile.path, normalizedIconUrl);
      })
  );
}

function limitDockFiles(
  dockFiles: readonly WorkbenchDockFileMentionItem[],
  maxResults?: number
): WorkbenchDockFileMentionItem[] {
  return dockFiles.slice(0, maxResults ?? dockFiles.length);
}
