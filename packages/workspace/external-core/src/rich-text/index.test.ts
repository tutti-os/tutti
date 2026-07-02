import assert from "node:assert/strict";
import test from "node:test";
import {
  createTuttiExternalAtRichTextTriggerProvider,
  createTuttiExternalAtRichTextTriggerProviders,
  queryTuttiExternalAtRichTextTriggerItems
} from "./index.ts";
import type {
  TuttiExternalAtQueryInput,
  TuttiExternalAtQueryResult
} from "../contracts/index.ts";

test("creates one rich text provider per requested external at provider", () => {
  const providers = createTuttiExternalAtRichTextTriggerProviders({
    bridge: null,
    providerIds: ["workspace-app", "agent-target", "agent-session"]
  });

  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["workspace-app", "agent-target", "agent-session"]
  );
  assert.deepEqual(
    providers.map((provider) => provider.trigger),
    ["@", "@", "@"]
  );
});

test("queries the external bridge with the provider filter", async () => {
  const calls: TuttiExternalAtQueryInput[] = [];
  const provider = createTuttiExternalAtRichTextTriggerProvider({
    providerId: "workspace-app",
    bridge: {
      at: {
        query(input) {
          calls.push(input);
          return [
            createQueryResult("workspace-app", "apps", "Apps"),
            createQueryResult("agent-session", "session", "Session")
          ];
        }
      }
    }
  });

  const results = await provider.query({
    keyword: "app",
    maxResults: 5,
    context: {},
    trigger: "@"
  });

  assert.deepEqual(calls, [
    {
      keyword: "app",
      maxResults: 5,
      providers: ["workspace-app"]
    }
  ]);
  assert.deepEqual(
    results.map((item) => item.providerId),
    ["workspace-app"]
  );
});

test("defaults external at rich text providers to include agent targets", () => {
  const providers = createTuttiExternalAtRichTextTriggerProviders({
    bridge: null
  });

  assert.ok(providers.some((provider) => provider.id === "agent-target"));
});

test("queries multiple external at providers with one bridge call", async () => {
  const calls: TuttiExternalAtQueryInput[] = [];
  const results = await queryTuttiExternalAtRichTextTriggerItems({
    keyword: "a",
    maxResults: 10,
    providerIds: ["workspace-app", "agent-session"],
    bridge: {
      at: {
        query(input) {
          calls.push(input);
          return [
            createQueryResult("workspace-app", "apps", "Apps"),
            createQueryResult("agent-session", "session", "Session"),
            createQueryResult("file", "README.md", "README.md")
          ];
        }
      }
    }
  });

  assert.deepEqual(calls, [
    {
      keyword: "a",
      maxResults: 10,
      providers: ["workspace-app", "agent-session"]
    }
  ]);
  assert.deepEqual(
    results.map((item) => item.providerId),
    ["workspace-app", "agent-session"]
  );
});

test("preserves an explicit empty external at provider filter", async () => {
  const calls: TuttiExternalAtQueryInput[] = [];
  const results = await queryTuttiExternalAtRichTextTriggerItems({
    keyword: "a",
    providerIds: [],
    bridge: {
      at: {
        query(input) {
          calls.push(input);
          return [createQueryResult("workspace-app", "apps", "Apps")];
        }
      }
    }
  });

  assert.deepEqual(calls, [
    {
      keyword: "a",
      providers: []
    }
  ]);
  assert.deepEqual(results, []);
  assert.deepEqual(
    createTuttiExternalAtRichTextTriggerProviders({
      bridge: null,
      providerIds: []
    }),
    []
  );
});

test("maps query results to the rich text trigger provider shape", () => {
  const provider = createTuttiExternalAtRichTextTriggerProvider({
    providerId: "agent-session",
    bridge: null
  });
  const item = createQueryResult("agent-session", "run-1", "Run 1", {
    subtitle: "created",
    thumbnailUrl: "https://example.test/run.png"
  });

  assert.equal(provider.getItemKey(item), "run-1");
  assert.equal(provider.getItemLabel(item), "Run 1");
  assert.equal(provider.getItemSubtitle?.(item), "created");
  assert.equal(provider.getItemIconUrl?.(item), "https://example.test/run.png");
  assert.deepEqual(provider.toInsertResult(item), item.insert);
});

test("uses mention presentation icons when thumbnailUrl is absent", () => {
  const provider = createTuttiExternalAtRichTextTriggerProvider({
    providerId: "agent-session",
    bridge: null
  });
  const item = createQueryResult("agent-session", "run-1", "Run 1", {
    insert: {
      kind: "mention",
      mention: {
        entityId: "run-1",
        label: "Run 1",
        presentation: {
          iconUrl: "https://example.test/icon.png"
        }
      }
    }
  });

  assert.equal(
    provider.getItemIconUrl?.(item),
    "https://example.test/icon.png"
  );
});

function createQueryResult(
  providerId: TuttiExternalAtQueryResult["providerId"],
  itemId: string,
  label: string,
  overrides: Partial<TuttiExternalAtQueryResult> = {}
): TuttiExternalAtQueryResult {
  return {
    providerId,
    itemId,
    label,
    insert: {
      kind: "mention",
      mention: {
        entityId: itemId,
        label
      }
    },
    ...overrides
  };
}
