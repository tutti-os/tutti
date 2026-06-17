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

  const thumbnailUrlByPath = new Map<string, string>();

  return {
    ...provider,
    async query(input) {
      const keyword = input.keyword.trim();
      const allDockFiles = options.resolveDockFiles();
      await hydrateDockFileThumbnails({
        dockFiles: allDockFiles,
        readDockPreview: options.readDockPreview,
        thumbnailUrlByPath
      });

      if (!keyword) {
        return filterDockFiles(allDockFiles, input.maxResults) as unknown as
          | readonly TItem[]
          | Promise<readonly TItem[]>;
      }

      const [dockMatches, searchResults] = await Promise.all([
        Promise.resolve(
          filterDockFiles(allDockFiles, input.maxResults, keyword)
        ),
        Promise.resolve(provider.query(input))
      ]);
      const merged = mergeDockAndSearchResults({
        dockMatches: dockMatches as unknown as readonly TItem[],
        getItemKey: provider.getItemKey,
        maxResults: input.maxResults,
        searchResults
      });
      return merged;
    },
    getItemThumbnailUrl(item) {
      const path = provider.getItemKey(item);
      if (resolveAgentMentionFileVisualKind({ path }) !== "image") {
        return null;
      }
      return thumbnailUrlByPath.get(path) ?? null;
    }
  };
}

async function hydrateDockFileThumbnails(input: {
  dockFiles: readonly WorkbenchDockFileMentionItem[];
  readDockPreview?: WorkbenchDockPreviewCache["read"];
  thumbnailUrlByPath: Map<string, string>;
}): Promise<void> {
  input.thumbnailUrlByPath.clear();
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
        const thumbnailUrl = await input
          .readDockPreview?.(dockFile.previewCacheKey)
          .catch(() => null);
        const normalizedThumbnailUrl = thumbnailUrl?.trim() ?? "";
        if (!normalizedThumbnailUrl) {
          return;
        }
        input.thumbnailUrlByPath.set(dockFile.path, normalizedThumbnailUrl);
      })
  );
}

function filterDockFiles(
  dockFiles: readonly WorkbenchDockFileMentionItem[],
  maxResults?: number,
  keyword?: string
): WorkbenchDockFileMentionItem[] {
  const normalizedKeyword = keyword?.trim().toLowerCase() ?? "";
  const filtered = normalizedKeyword
    ? dockFiles.filter((item) =>
        matchesDockFileKeyword(item, normalizedKeyword)
      )
    : dockFiles;
  return filtered.slice(0, maxResults ?? filtered.length);
}

function matchesDockFileKeyword(
  item: WorkbenchDockFileMentionItem,
  keyword: string
): boolean {
  const haystack = `${item.displayName}\n${item.path}`.toLowerCase();
  return keyword
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function mergeDockAndSearchResults<TItem>(input: {
  dockMatches: readonly TItem[];
  getItemKey: (item: TItem) => string;
  maxResults?: number;
  searchResults: readonly TItem[];
}): readonly TItem[] {
  const seen = new Set<string>();
  const merged: TItem[] = [];

  for (const item of [...input.dockMatches, ...input.searchResults]) {
    const key = input.getItemKey(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
    if (input.maxResults !== undefined && merged.length >= input.maxResults) {
      break;
    }
  }

  return merged;
}
