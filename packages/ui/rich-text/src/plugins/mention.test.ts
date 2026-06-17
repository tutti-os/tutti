import assert from "node:assert/strict";
import test from "node:test";
import {
  createRichTextMentionAttrs,
  resolveRichTextMentionView
} from "./mention.ts";

test("resolveRichTextMentionView does not expose stored href without explicit resolution", () => {
  const mention = createRichTextMentionAttrs("user", {
    entityId: "u_123",
    label: "Alice",
    presentation: {
      iconUrl: "https://example.test/alice.png"
    }
  });

  const view = resolveRichTextMentionView(mention);

  assert.equal(view.state, "active");
  assert.deepEqual(view.presentation, {
    iconUrl: "https://example.test/alice.png"
  });
});

test("resolveRichTextMentionView keeps explicit resolved presentation", () => {
  const mention = createRichTextMentionAttrs("user", {
    entityId: "u_123",
    label: "Alice"
  });

  const view = resolveRichTextMentionView(mention, {
    presentation: {
      subtitle: "Design"
    },
    state: "active"
  });

  assert.deepEqual(view.presentation, {
    subtitle: "Design"
  });
});
