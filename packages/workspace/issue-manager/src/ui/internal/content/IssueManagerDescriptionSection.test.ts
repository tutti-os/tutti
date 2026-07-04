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
    /className="min-w-0 max-w-full \[overflow-wrap:anywhere\]/
  );
  assert.match(
    descriptionSectionSource,
    /paragraphClassName="break-words leading-5 \[overflow-wrap:anywhere\]"/
  );
});

test("description readonly mentions stay on the body text rhythm", () => {
  assert.match(descriptionSectionSource, /\[&>\*\+\*\]:!mt-1/);
  assert.match(
    descriptionSectionSource,
    /\[&_\.tutti-rich-text-mention\]:!\[line-height:20px\]/
  );
  assert.match(
    descriptionSectionSource,
    /\[&_\.tutti-rich-text-mention\]:!py-0/
  );
});
