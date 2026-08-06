import assert from "node:assert/strict";
import test from "node:test";
import { createRichTextTriggerRegistry } from "../plugins/triggerRegistry.ts";
import { createRichTextMarkdownLinkInsertResult } from "../plugins/trigger.ts";
import type {
  RichTextTriggerProvider,
  RichTextTriggerQueryMatch,
  RichTextTriggerRegistry
} from "../types/trigger.ts";
import {
  enterRichTextTriggerDirectory,
  exitRichTextTriggerDirectory,
  resolveRichTextTriggerDirectoryItemAction
} from "./richTextTriggerDirectoryNavigation.ts";
import { queryRichTextTriggerDirectoryMatches } from "./richTextTriggerQuery.ts";

function directoryMatch(): RichTextTriggerQueryMatch {
  return {
    directory: { path: "/workspace/docs" },
    insertResult: createRichTextMarkdownLinkInsertResult(
      "docs",
      "/workspace/docs/"
    ),
    item: {},
    key: "/workspace/docs",
    label: "docs",
    providerId: "file",
    trigger: "@"
  };
}

test("legacy rich text trigger registries can omit directory browsing", () => {
  const registry: RichTextTriggerRegistry = {
    getProvider: () => undefined,
    listProviders: () => [],
    listTriggerConfigs: () => [],
    query: async () => []
  };

  assert.equal(registry.queryDirectory, undefined);
});

test("RichTextTriggerEditor keeps directory body selection insertable", () => {
  assert.equal(
    resolveRichTextTriggerDirectoryItemAction({
      interaction: "select",
      match: directoryMatch(),
      providerId: "file"
    }),
    "insert"
  );
});

test("RichTextTriggerEditor enters folders only through hierarchy navigation", () => {
  assert.equal(
    resolveRichTextTriggerDirectoryItemAction({
      interaction: "navigate",
      match: directoryMatch(),
      providerId: "file"
    }),
    "enter"
  );
  assert.deepEqual(enterRichTextTriggerDirectory([], "/workspace/docs"), [
    "/workspace/docs"
  ]);
  assert.deepEqual(
    exitRichTextTriggerDirectory(["/workspace/docs", "/workspace/docs/api"]),
    ["/workspace/docs"]
  );
});

test("RichTextTriggerEditor directory request respects abort fencing", async () => {
  let release: (() => void) | undefined;
  const provider = {
    id: "file",
    trigger: "@",
    query: () => [],
    queryDirectory: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [{ kind: "file", path: "/workspace/docs/readme.md" }];
    },
    getItemKey: (item) => item.path,
    getItemLabel: (item) => item.path,
    toInsertResult: (item) =>
      createRichTextMarkdownLinkInsertResult(item.path, item.path)
  } satisfies RichTextTriggerProvider<{ kind: string; path: string }>;
  const registry = createRichTextTriggerRegistry([provider]);
  const abortController = new AbortController();
  const pending = queryRichTextTriggerDirectoryMatches(registry, "file", {
    abortSignal: abortController.signal,
    context: {},
    directoryPath: "/workspace/docs",
    keyword: "",
    trigger: "@"
  });
  abortController.abort();
  release?.();
  assert.deepEqual(await pending, []);
});

test("RichTextTriggerEditor directory request preserves provider errors", async () => {
  const registry = createRichTextTriggerRegistry([
    {
      id: "file",
      trigger: "@",
      query: () => [],
      queryDirectory: async () => {
        throw new Error("directory unavailable");
      },
      getItemKey: () => "unused",
      getItemLabel: () => "unused",
      toInsertResult: () =>
        createRichTextMarkdownLinkInsertResult("unused", "/unused")
    }
  ]);

  await assert.rejects(
    queryRichTextTriggerDirectoryMatches(registry, "file", {
      context: {},
      directoryPath: "",
      keyword: "",
      trigger: "@"
    }),
    /directory unavailable/
  );
});

test("directory registry discards results aborted during async item mapping", async () => {
  let releaseIcon: (() => void) | undefined;
  const provider = {
    id: "file",
    trigger: "@",
    query: () => [],
    queryDirectory: () => [{ kind: "file", path: "/workspace/readme.md" }],
    getItemKey: (item) => item.path,
    getItemLabel: (item) => item.path,
    getItemIconUrl: async () => {
      await new Promise<void>((resolve) => {
        releaseIcon = resolve;
      });
      return "file:///icon.png";
    },
    toInsertResult: (item) =>
      createRichTextMarkdownLinkInsertResult(item.path, item.path)
  } satisfies RichTextTriggerProvider<{ kind: string; path: string }>;
  const registry = createRichTextTriggerRegistry([provider]);
  const abortController = new AbortController();

  const pending = registry.queryDirectory("file", {
    abortSignal: abortController.signal,
    context: {},
    directoryPath: "",
    keyword: "",
    trigger: "@"
  });
  abortController.abort();
  releaseIcon?.();

  assert.deepEqual(await pending, []);
});
