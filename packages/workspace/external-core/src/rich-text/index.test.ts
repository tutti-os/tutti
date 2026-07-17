import assert from "node:assert/strict";
import test from "node:test";
import {
  createTuttiExternalAtRichTextTriggerProvider,
  createTuttiExternalAtRichTextTriggerProviders,
  createTuttiExternalRichTextMentionService,
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

test("uses exact host resolve when the optional bridge capability exists", async () => {
  const provider = createTuttiExternalAtRichTextTriggerProvider({
    providerId: "workspace-app",
    getBridge: () => ({
      at: {
        query: () => [],
        resolve(input) {
          assert.deepEqual(input, {
            providerId: "workspace-app",
            entityId: "canvas",
            scope: { workspaceId: "workspace-1" }
          });
          return {
            label: "Canvas",
            presentation: { iconUrl: "canvas.png" }
          };
        }
      }
    })
  });

  assert.deepEqual(
    await provider.resolveMention?.({
      providerId: "workspace-app",
      entityId: "canvas",
      label: "Old canvas",
      scope: { workspaceId: "workspace-1" }
    }),
    { label: "Canvas", presentation: { iconUrl: "canvas.png" } }
  );
});

test("falls back to an exact identity and scope match on old hosts", async () => {
  const calls: TuttiExternalAtQueryInput[] = [];
  const provider = createTuttiExternalAtRichTextTriggerProvider({
    providerId: "workspace-app",
    bridge: {
      at: {
        query(input) {
          calls.push(input);
          return [
            createQueryResult("workspace-app", "canvas", "Wrong scope", {
              insert: {
                kind: "mention",
                mention: {
                  entityId: "canvas",
                  label: "Wrong scope",
                  scope: { workspaceId: "workspace-2" }
                }
              }
            }),
            createQueryResult("workspace-app", "canvas", "Canvas", {
              insert: {
                kind: "mention",
                mention: {
                  entityId: "canvas",
                  label: "Canvas",
                  scope: { workspaceId: "workspace-1" },
                  presentation: { iconUrl: "canvas.png" }
                }
              }
            })
          ];
        }
      }
    }
  });

  const resolved = await provider.resolveMention?.({
    providerId: "workspace-app",
    entityId: "canvas",
    label: "Old canvas",
    scope: { workspaceId: "workspace-1" }
  });
  assert.deepEqual(calls, [
    { keyword: "Old canvas", maxResults: 50, providers: ["workspace-app"] }
  ]);
  assert.deepEqual(resolved, {
    label: "Canvas",
    presentation: { iconUrl: "canvas.png" }
  });
});

test("old host resolution retries with an empty keyword after a label miss", async () => {
  const calls: TuttiExternalAtQueryInput[] = [];
  const provider = createTuttiExternalAtRichTextTriggerProvider({
    providerId: "workspace-app",
    bridge: {
      at: {
        query(input) {
          calls.push(input);
          return input.keyword
            ? []
            : [
                createQueryResult("workspace-app", "canvas", "Renamed", {
                  insert: {
                    kind: "mention",
                    mention: {
                      entityId: "canvas",
                      label: "Renamed",
                      scope: { workspaceId: "workspace-1" }
                    }
                  }
                })
              ];
        }
      }
    }
  });

  assert.deepEqual(
    await provider.resolveMention?.({
      providerId: "workspace-app",
      entityId: "canvas",
      label: "Old canvas",
      scope: { workspaceId: "workspace-1" }
    }),
    { label: "Renamed", presentation: undefined }
  );
  assert.deepEqual(calls, [
    { keyword: "Old canvas", maxResults: 50, providers: ["workspace-app"] },
    { keyword: "", maxResults: 50, providers: ["workspace-app"] }
  ]);
});

test("external service invalidates from bridge events and unsubscribes", async () => {
  let listener:
    | ((event: { providerIds?: readonly ["workspace-app"] }) => void)
    | undefined;
  let unsubscribeCalls = 0;
  let icon = "first.png";
  const service = createTuttiExternalRichTextMentionService({
    providerIds: ["workspace-app"],
    getBridge: () => ({
      at: {
        query: () => [],
        resolve: () => ({ presentation: { iconUrl: icon } }),
        subscribe(nextListener) {
          listener = nextListener;
          return () => {
            unsubscribeCalls += 1;
          };
        }
      }
    })
  });
  const mention = {
    providerId: "workspace-app",
    entityId: "canvas",
    label: "Canvas"
  };
  await service.resolve(mention);
  icon = "second.png";
  listener?.({ providerIds: ["workspace-app"] });
  await service.resolve(mention);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    service.getSnapshot(mention).resolved?.presentation?.iconUrl,
    "second.png"
  );
  service.dispose();
  service.dispose();
  assert.equal(unsubscribeCalls, 1);
});

test("external service getBridge remains SSR-safe when unavailable", async () => {
  const service = createTuttiExternalRichTextMentionService({
    getBridge: () => undefined,
    providerIds: ["workspace-app"]
  });
  assert.equal(
    (
      await service.resolve({
        providerId: "workspace-app",
        entityId: "canvas",
        label: "Canvas"
      })
    ).state,
    "missing"
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
