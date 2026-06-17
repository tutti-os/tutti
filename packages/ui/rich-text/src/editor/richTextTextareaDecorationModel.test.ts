import assert from "node:assert/strict";
import test from "node:test";
import { buildRichTextTextareaDecorationSegments } from "./richTextTextareaDecorationModel.ts";

test("decorates markdown links with spaces and parentheses in hrefs", () => {
  const linkText =
    "[White House (cropped).jpg](/Users/example/Downloads/White House (cropped).jpg)";
  const content = `See ${linkText} now`;
  const segments = buildRichTextTextareaDecorationSegments(content);

  assert.equal(segments.length, 3);
  assert.deepEqual(segments[1], {
    type: "link",
    text: linkText,
    from: 4,
    to: 4 + linkText.length,
    label: "White House (cropped).jpg",
    href: "/Users/example/Downloads/White House (cropped).jpg",
    kind: "file"
  });
});
