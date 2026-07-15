import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "@tutti-os/agent-gui/context-mention-provider";
import type { AgentContextMentionProvider } from "@tutti-os/agent-gui/context-mention-provider";
import type { WorkbenchDockPreviewCacheKey } from "@tutti-os/workbench-surface";
import { wrapDesktopFileMentionProviderWithDockFiles } from "./wrapDesktopFileMentionProviderWithDockFiles.ts";

const { file: FILE_PROVIDER_ID } = AGENT_CONTEXT_MENTION_PROVIDER_IDS;

const previewCacheKey: WorkbenchDockPreviewCacheKey = {
  instanceId: "path:readme",
  instanceKey: null,
  nodeId: "preview-readme",
  typeId: "workspace-text-file",
  workspaceId: "workspace-1"
};

function createTestFileProvider(
  query: AgentContextMentionProvider<{
    displayName: string;
    path: string;
  }>["query"]
): AgentContextMentionProvider<{ displayName: string; path: string }> {
  return {
    id: FILE_PROVIDER_ID,
    trigger: "@",
    query,
    getItemKey: (item) => item.path,
    getItemLabel: (item) => item.displayName,
    toInsertResult: (item) => ({
      kind: "markdown-link",
      href: item.path,
      label: item.displayName
    })
  };
}

test("wrapDesktopFileMentionProviderWithDockFiles returns dock files for blank queries", async () => {
  const provider = wrapDesktopFileMentionProviderWithDockFiles(
    createTestFileProvider(async () => []),
    {
      resolveDockFiles: () => [
        {
          displayName: "README.md",
          kind: "file",
          path: "/workspace/README.md",
          previewCacheKey
        }
      ]
    }
  );

  const items = await provider.query({
    keyword: "",
    context: {},
    trigger: "@"
  });

  assert.deepEqual(items, [
    {
      displayName: "README.md",
      kind: "file",
      path: "/workspace/README.md",
      previewCacheKey
    }
  ]);
});

test("wrapDesktopFileMentionProviderWithDockFiles preserves provider relevance for non-blank searches", async () => {
  const provider = wrapDesktopFileMentionProviderWithDockFiles(
    createTestFileProvider(async () => [
      {
        displayName: "user",
        path: "/Users/Sun/user"
      },
      {
        displayName: "USER.md",
        path: "/Users/Sun/docs/USER.md"
      }
    ]),
    {
      resolveDockFiles: () => [
        {
          displayName: "renderer.js",
          kind: "file",
          path: "/Users/Sun/project/renderer.js",
          previewCacheKey
        }
      ]
    }
  );

  const items = await provider.query({
    keyword: "user",
    context: {},
    trigger: "@"
  });

  assert.deepEqual(items, [
    {
      displayName: "user",
      path: "/Users/Sun/user"
    },
    {
      displayName: "USER.md",
      path: "/Users/Sun/docs/USER.md"
    }
  ]);
});

test("wrapDesktopFileMentionProviderWithDockFiles exposes dock preview thumbnails only for image files", async () => {
  const imagePreviewCacheKey: WorkbenchDockPreviewCacheKey = {
    ...previewCacheKey,
    nodeId: "preview-image"
  };
  const provider = wrapDesktopFileMentionProviderWithDockFiles(
    createTestFileProvider(async () => []),
    {
      readDockPreview: async (key) =>
        key.nodeId === imagePreviewCacheKey.nodeId
          ? "data:image/png;base64,preview"
          : null,
      resolveDockFiles: () => [
        {
          displayName: "README.md",
          kind: "file",
          path: "/workspace/README.md",
          previewCacheKey
        },
        {
          displayName: "diagram.png",
          kind: "file",
          path: "/workspace/diagram.png",
          previewCacheKey: imagePreviewCacheKey
        }
      ]
    }
  );

  await provider.query({
    keyword: "",
    context: {},
    trigger: "@"
  });

  assert.equal(
    await provider.getItemIconUrl?.({
      displayName: "README.md",
      path: "/workspace/README.md"
    }),
    null
  );
  assert.equal(
    await provider.getItemIconUrl?.({
      displayName: "diagram.png",
      path: "/workspace/diagram.png"
    }),
    "data:image/png;base64,preview"
  );
});
