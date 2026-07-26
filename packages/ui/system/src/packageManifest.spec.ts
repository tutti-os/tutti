import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));

test("marks native-only peers optional for web consumers", () => {
  expect(manifest.peerDependenciesMeta).toMatchObject({
    "react-native": { optional: true }
  });
});
