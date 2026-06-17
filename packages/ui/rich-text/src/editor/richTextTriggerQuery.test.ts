import assert from "node:assert/strict";
import test from "node:test";
import { createRichTextTriggerRegistry } from "../plugins/triggerRegistry.ts";
import {
  createRichTextMentionInsertResult,
  createRichTextTriggerProvider,
  createRichTextTextInsertResult
} from "../plugins/trigger.ts";
import {
  findRichTextTriggerQuery,
  queryRichTextTriggerMatches
} from "./richTextTriggerQuery.ts";

test("findRichTextTriggerQuery supports @ after punctuation boundaries", () => {
  assert.deepEqual(
    findRichTextTriggerQuery("hello, @rea", 11, [
      { trigger: "@", boundary: "punctuation" }
    ]),
    {
      from: 7,
      to: 11,
      trigger: "@",
      keyword: "rea"
    }
  );
  assert.deepEqual(
    findRichTextTriggerQuery("see(@rea", 8, [
      { trigger: "@", boundary: "punctuation" }
    ]),
    {
      from: 4,
      to: 8,
      trigger: "@",
      keyword: "rea"
    }
  );
});

test("findRichTextTriggerQuery keeps slash and dot inside the query", () => {
  assert.deepEqual(
    findRichTextTriggerQuery("@src/index.ts", 13, [
      { trigger: "@", boundary: "punctuation" }
    ]),
    {
      from: 0,
      to: 13,
      trigger: "@",
      keyword: "src/index.ts"
    }
  );
});

test("findRichTextTriggerQuery ignores @ inside email-like tokens", () => {
  assert.equal(
    findRichTextTriggerQuery("alice@example", 13, [
      { trigger: "@", boundary: "punctuation" }
    ]),
    null
  );
});

test("findRichTextTriggerQuery supports slash and dollar triggers", () => {
  assert.deepEqual(
    findRichTextTriggerQuery("/review", 7, [
      { trigger: "/", boundary: "punctuation" }
    ]),
    {
      from: 0,
      to: 7,
      trigger: "/",
      keyword: "review"
    }
  );
  assert.deepEqual(
    findRichTextTriggerQuery("run $skill", 10, [
      { trigger: "$", boundary: "punctuation" }
    ]),
    {
      from: 4,
      to: 10,
      trigger: "$",
      keyword: "skill"
    }
  );
  assert.equal(
    findRichTextTriggerQuery("/review", 7, [
      { trigger: "@", boundary: "punctuation" }
    ]),
    null
  );
});

test("findRichTextTriggerQuery decouples trigger symbol from boundary policy", () => {
  assert.equal(
    findRichTextTriggerQuery("see(/review", 11, [
      { trigger: "/", boundary: "whitespace" }
    ]),
    null
  );
  assert.equal(
    findRichTextTriggerQuery("http://example", 14, [
      { trigger: "/", boundary: "whitespace" }
    ]),
    null
  );
  assert.deepEqual(
    findRichTextTriggerQuery("see(/review", 11, [
      { trigger: "/", boundary: "punctuation" }
    ]),
    {
      from: 4,
      to: 11,
      trigger: "/",
      keyword: "review"
    }
  );
  assert.deepEqual(
    findRichTextTriggerQuery("run /review", 11, [
      { trigger: "/", boundary: "whitespace" }
    ]),
    {
      from: 4,
      to: 11,
      trigger: "/",
      keyword: "review"
    }
  );
});

test("queryRichTextTriggerMatches dispatches only to the matching trigger", async () => {
  const registry = createRichTextTriggerRegistry([
    createRichTextTriggerProvider({
      id: "mention",
      trigger: "@",
      query() {
        return [{ id: "mention" }];
      },
      getItemKey: (item) => item.id,
      getItemLabel: (item) => item.id,
      toInsertResult: (item) => createRichTextTextInsertResult(item.id)
    }),
    createRichTextTriggerProvider({
      id: "slash",
      trigger: "/",
      boundary: "whitespace",
      query() {
        return [{ id: "slash" }];
      },
      getItemKey: (item) => item.id,
      getItemLabel: (item) => item.id,
      toInsertResult: (item) => createRichTextTextInsertResult(item.id)
    })
  ]);

  const matches = await queryRichTextTriggerMatches(registry, {
    context: {},
    keyword: "re",
    maxResults: 5,
    trigger: "/"
  });

  assert.deepEqual(
    matches.map((match) => [match.providerId, match.trigger, match.key]),
    [["slash", "/", "slash"]]
  );
  assert.deepEqual(registry.listTriggerConfigs(), [
    { trigger: "@", boundary: "punctuation" },
    { trigger: "/", boundary: "whitespace" }
  ]);
});

test("queryRichTextTriggerMatches returns empty results when a provider throws", async () => {
  const registry = createRichTextTriggerRegistry([
    createRichTextTriggerProvider({
      id: "broken",
      trigger: "@",
      async query() {
        throw new Error("search failed");
      },
      getItemKey: () => "broken",
      getItemLabel: () => "broken",
      toInsertResult: () => createRichTextTextInsertResult("broken")
    })
  ]);

  const matches = await queryRichTextTriggerMatches(registry, {
    context: {},
    keyword: "rea",
    maxResults: 5,
    trigger: "@"
  });

  assert.deepEqual(matches, []);
});

test("queryRichTextTriggerMatches returns empty results after abort", async () => {
  const registry = createRichTextTriggerRegistry([
    createRichTextTriggerProvider({
      id: "slow",
      trigger: "@",
      async query() {
        await Promise.resolve();
        return [{ id: "readme" }];
      },
      getItemKey: (item) => item.id,
      getItemLabel: (item) => item.id,
      toInsertResult: (item) => createRichTextTextInsertResult(item.id)
    })
  ]);
  const abortController = new AbortController();

  const matchesPromise = queryRichTextTriggerMatches(registry, {
    abortSignal: abortController.signal,
    context: {},
    keyword: "rea",
    maxResults: 5,
    trigger: "@"
  });
  abortController.abort();

  const matches = await matchesPromise;
  assert.deepEqual(matches, []);
});

test("queryRichTextTriggerMatches resolves provider icons", async () => {
  const registry = createRichTextTriggerRegistry([
    createRichTextTriggerProvider({
      id: "workspace-app",
      trigger: "@",
      query() {
        return [{ appId: "automation", label: "Automation" }];
      },
      getItemKey: (item) => item.appId,
      getItemLabel: (item) => item.label,
      getItemIconUrl: () => "tutti://workspace-apps/automation/icon.png",
      toInsertResult: (item) => createRichTextTextInsertResult(item.label)
    })
  ]);

  const matches = await queryRichTextTriggerMatches(registry, {
    context: {},
    keyword: "auto",
    maxResults: 5,
    trigger: "@"
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.providerId, "workspace-app");
  assert.equal(
    matches[0]?.iconUrl,
    "tutti://workspace-apps/automation/icon.png"
  );
});

test("queryRichTextTriggerMatches reads mention presentation icon", async () => {
  const registry = createRichTextTriggerRegistry([
    createRichTextTriggerProvider({
      id: "agent-session",
      trigger: "@",
      query() {
        return [{ id: "session-1", label: "Codex run" }];
      },
      getItemKey: (item) => item.id,
      getItemLabel: (item) => item.label,
      toInsertResult: (item) =>
        createRichTextMentionInsertResult({
          entityId: item.id,
          label: item.label,
          presentation: {
            iconUrl: "tutti://agents/codex.png"
          }
        })
    })
  ]);

  const matches = await queryRichTextTriggerMatches(registry, {
    context: {},
    keyword: "codex",
    maxResults: 5,
    trigger: "@"
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.iconUrl, "tutti://agents/codex.png");
});
