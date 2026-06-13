import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const descriptionSectionSource = readFileSync(
  new URL("./IssueManagerDescriptionSection.tsx", import.meta.url),
  "utf8"
);

test("description readonly content wraps long unbroken text", () => {
  assert.match(
    descriptionSectionSource,
    /className="min-w-0 max-w-full \[overflow-wrap:anywhere\]"/
  );
  assert.match(
    descriptionSectionSource,
    /paragraphClassName="break-words \[overflow-wrap:anywhere\]"/
  );
});
