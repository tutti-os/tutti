import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./AppCard.tsx", import.meta.url), "utf8");

test("App Card primary action label stays inside the card header", () => {
  assert.match(
    source,
    /className="flex min-w-0 flex-1 items-center justify-end gap-1"/
  );
  assert.match(source, /"min-w-0 max-w-full shrink truncate px-2"/);
  assert.match(source, /title=\{primaryActionTitle\}/);
});
