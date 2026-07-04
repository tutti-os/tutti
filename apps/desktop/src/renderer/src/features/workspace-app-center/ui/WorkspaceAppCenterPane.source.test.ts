import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./WorkspaceAppCenterPane.tsx", import.meta.url),
  "utf8"
);

test("App Center passes the Tutti package icon for official developer sources", () => {
  assert.match(source, /dock\/default\/tutti\.png/);
  assert.match(source, /officialDeveloperIconUrl=\{tuttiDeveloperIconUrl\}/);
});

test("group chat community developer opens the configured profile", () => {
  assert.match(source, /"group-chat": \{/);
  assert.match(source, /name: "svenzeng"/);
  assert.match(source, /url: "https:\/\/github\.com\/tutti-os\/tutti"/);
  assert.match(source, /communityAppDeveloperOverrides/);
});

test("App Center developer links open through the desktop host external opener", () => {
  assert.match(
    source,
    /openExternalUrl: \(url\) => service\.openExternalUrl\(url\)/
  );
});
