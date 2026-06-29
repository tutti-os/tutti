import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Browser Node webview allows popup windows", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "BrowserNode.tsx"),
    "utf8"
  );

  assert.match(
    source,
    /browserNodeAllowPopupsAttribute = "true" as unknown as boolean/
  );
  assert.match(
    source,
    /<webview[\s\S]*\sallowpopups=\{browserNodeAllowPopupsAttribute\}[\s\S]*\/>/
  );
});

test("Browser Node workbench header places window controls on the leading side", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "BrowserNode.tsx"),
    "utf8"
  );

  assert.match(
    source,
    /data-browser-node-header="true"[\s\S]*\{defaultActions \? \([\s\S]*<span[\s\S]*\{defaultActions\}[\s\S]*<div className="inline-flex items-center gap-1">/
  );
  assert.match(source, /data-browser-node-header-display-mode=\{displayMode\}/);
});

test("Browser Node address bar stays close to navigation controls", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "BrowserNode.tsx"),
    "utf8"
  );

  assert.match(
    source,
    /className="h-full w-1\.5 shrink-0 cursor-grab active:cursor-grabbing"[\s\S]*data-browser-node-drag-gutter="true"/
  );
  assert.doesNotMatch(source, /className="h-full w-8 shrink-0 cursor-grab/);
});
