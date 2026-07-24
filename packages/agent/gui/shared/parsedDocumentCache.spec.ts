import { afterEach, describe, expect, it } from "vitest";
import {
  parsedDocumentCacheStatsForTests,
  readParsedDocumentCache,
  resetParsedDocumentCacheForTests
} from "./parsedDocumentCache";

describe("parsedDocumentCache", () => {
  afterEach(() => {
    resetParsedDocumentCacheForTests();
  });

  it("is bounded and keeps recently used documents", () => {
    const first = { type: "doc" };
    readParsedDocumentCache({
      namespace: "test",
      identity: "first",
      source: "first",
      create: () => first
    });
    expect(
      readParsedDocumentCache({
        namespace: "test",
        identity: "first",
        source: "first",
        create: () => ({ type: "unexpected" })
      })
    ).toBe(first);

    for (let index = 0; index < 300; index += 1) {
      readParsedDocumentCache({
        namespace: "test",
        identity: `message-${index}`,
        source: `message-${index}`,
        create: () => ({ index })
      });
    }

    expect(parsedDocumentCacheStatsForTests()).toMatchObject({
      entries: 256,
      hits: 1,
      misses: 301
    });
  });
});
