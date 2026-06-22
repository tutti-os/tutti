import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./AppCenterPanel.tsx", import.meta.url),
  "utf8"
);

test("App Center empty app list fills the tab content before centering text", () => {
  assert.match(
    source,
    /<section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">/
  );
  assert.match(
    source,
    /className="flex min-h-0 min-w-0 flex-1 items-center justify-center rounded-\[8px\]/
  );
});

test("recommended category tabs keep enough vertical room for the selected pill", () => {
  assert.match(
    source,
    /className="-mx-1 flex min-h-10 min-w-0 items-center gap-2 overflow-x-auto px-1 py-1"/
  );
  assert.match(source, /shadow-\[inset_0_0_0_1px_var\(--line-1\)\]/);
});

test("App Center app grid keeps bottom padding above the window edge", () => {
  assert.match(
    source,
    /className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-6 pt-5 \[container-type:inline-size\]"/
  );
  assert.match(source, /<div className="flex min-w-0 shrink-0 flex-col">/);
  assert.match(
    source,
    /className="grid min-h-0 min-w-0 grid-cols-\[repeat\(auto-fill,minmax\(min\(100%,260px\),1fr\)\)\] gap-3"/
  );
  assert.match(source, /<div aria-hidden="true" className="h-6 shrink-0" \/>/);
});

test("App factory loading controls do not render framed pills", () => {
  assert.match(
    source,
    /loading\s*\?\s*"animate-pulse rounded-none border-transparent bg-transparent px-1 opacity-100 shadow-none hover:bg-transparent disabled:bg-transparent disabled:opacity-100"/
  );
  assert.match(source, /disabled && !loading/);
});
