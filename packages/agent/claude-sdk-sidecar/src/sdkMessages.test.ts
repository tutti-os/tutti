import assert from "node:assert/strict";
import test from "node:test";
import { contextWindowTokensFromModelUsage } from "./sdkMessages.ts";

test("model usage context window follows the active model regardless of map order", () => {
  const modelUsages = [
    {
      "claude-haiku-4-5": { contextWindow: 200_000 },
      "claude-opus-4-6": { contextWindow: 1_000_000 }
    },
    {
      "claude-opus-4-6": { contextWindow: 1_000_000 },
      "claude-haiku-4-5": { contextWindow: 200_000 }
    }
  ];

  for (const modelUsage of modelUsages) {
    assert.equal(
      contextWindowTokensFromModelUsage(modelUsage, "opus"),
      1_000_000
    );
  }
});

test("model usage does not borrow another model context window", () => {
  assert.equal(
    contextWindowTokensFromModelUsage(
      {
        "claude-haiku-4-5": { contextWindow: 200_000 },
        "claude-sonnet-4-6": { contextWindow: 1_000_000 }
      },
      "opus"
    ),
    0
  );
});
