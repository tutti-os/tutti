import assert from "node:assert/strict";
import test from "node:test";
import {
  appendRichTextLinksToContent,
  createRichTextMentionHref,
  createRichTextMentionMarkdown,
  extractRichTextLinksFromContent,
  extractPlainTextFromContent,
  extractRichTextMentionsFromContent,
  normalizeRichTextLinkHref,
  parseRichTextContentToDocument,
  parseRichTextMentionHref,
  removeRichTextLinkFromContent,
  removeRichTextMentionFromContent,
  sanitizeRichTextMentionForAgentContext,
  sanitizeRichTextMentionScopeForAgentContext,
  serializeRichTextDocumentToContent
} from "./richTextDocument.ts";
import { createRichTextMentionAttrs } from "../plugins/mention.ts";

test("creates and parses a rich text mention href", () => {
  const mention = createRichTextMentionAttrs("user", {
    entityId: "u_123",
    label: "Alice Chen",
    scope: {
      workspaceId: "ws_1",
      topicId: "topic_1",
      empty: ""
    }
  });

  const href = createRichTextMentionHref(mention);
  assert.equal(href, "mention://user/u_123?topicId=topic_1&workspaceId=ws_1");

  assert.deepEqual(parseRichTextMentionHref(href, "@Alice Chen"), {
    trigger: "@",
    providerId: "user",
    entityId: "u_123",
    label: "Alice Chen",
    scope: {
      topicId: "topic_1",
      workspaceId: "ws_1"
    }
  });
});

test("serializes mention markdown with a normalized @ label", () => {
  assert.equal(
    createRichTextMentionMarkdown(
      createRichTextMentionAttrs("workspace-app", {
        entityId: "vibe-design",
        label: "@Prototype Design",
        scope: { workspaceId: "ws_1" }
      })
    ),
    "[@Prototype Design](mention://workspace-app/vibe-design?workspaceId=ws_1)"
  );
});

test("does not serialize reserved mention scope fields", () => {
  const mention = createRichTextMentionAttrs("provider", {
    entityId: "entity",
    label: "Entity",
    scope: {
      kind: "person",
      link: "/people/entity",
      appId: "reserved-app",
      id: "reserved-id",
      "meta.foo": "bar",
      provider: "reserved-provider",
      version: "1",
      workspaceId: "ws_1"
    }
  });

  assert.equal(
    createRichTextMentionHref(mention),
    "mention://provider/entity?workspaceId=ws_1"
  );
});

test("sanitizes rich text mention scope for agent context", () => {
  assert.deepEqual(
    sanitizeRichTextMentionScopeForAgentContext({
      workspaceId: " ws_1 ",
      topicId: "topic_1",
      iconUrl: "DATA:image/png;base64,weather",
      thumbnailUrl: "https://example.test/thumb.png",
      link: "/apps/weather",
      sourceUrl: "Blob:https://example.test/source",
      "meta.source": "presentation",
      large: "x".repeat(2049),
      empty: "",
      objectValue: { id: "not-string" }
    }),
    {
      topicId: "topic_1",
      workspaceId: "ws_1"
    }
  );
});

test("sanitizes rich text mention identity for agent context", () => {
  assert.deepEqual(
    sanitizeRichTextMentionForAgentContext({
      providerId: " workspace-app ",
      entityId: " weather ",
      label: " @Weather ",
      scope: {
        workspaceId: "ws_1",
        iconUrl: "data:image/png;base64,weather"
      }
    }),
    {
      providerId: "workspace-app",
      entityId: "weather",
      label: "Weather",
      scope: {
        workspaceId: "ws_1"
      }
    }
  );
});

test("rejects reserved rich text mention scope keys", () => {
  assert.equal(
    parseRichTextMentionHref(
      "mention://workspace-app?workspaceId=ws_1&appId=app_1",
      "@App"
    ),
    null
  );
  assert.equal(
    parseRichTextMentionHref(
      "mention://workspace-issue?workspaceId=ws_1&id=issue_1",
      "@Issue"
    ),
    null
  );
  assert.equal(
    parseRichTextMentionHref(
      "mention://agent-session?workspaceId=ws_1&id=session_1",
      "@Session"
    ),
    null
  );
  assert.equal(
    parseRichTextMentionHref(
      "mention://provider/entity?link=%2Fpeople%2Fu_123",
      "@Alice"
    ),
    null
  );
  assert.equal(
    parseRichTextMentionHref("mention://provider/entity?meta.foo=bar", "@Foo"),
    null
  );
  assert.equal(
    parseRichTextMentionHref("mention://provider/entity?kind=person", "@Foo"),
    null
  );
  assert.equal(
    parseRichTextMentionHref(
      "mention://provider/entity?provider=reserved-provider",
      "@Foo"
    ),
    null
  );
});

test("parses a rich text mention href without a display label", () => {
  assert.deepEqual(
    parseRichTextMentionHref(
      "mention://workspace-app/app_1?workspaceId=ws_1",
      ""
    ),
    {
      trigger: "@",
      providerId: "workspace-app",
      entityId: "app_1",
      label: "app_1",
      scope: {
        workspaceId: "ws_1"
      }
    }
  );
});

test("serializes and extracts mention markdown from content", () => {
  const alice = createRichTextMentionAttrs("user", {
    entityId: "u_123",
    label: "Alice",
    scope: { workspaceId: "ws_1" }
  });
  const issue = createRichTextMentionAttrs("issue", {
    entityId: "issue-7",
    label: "Issue 7"
  });

  const content = [
    "Please sync with",
    createRichTextMentionMarkdown(alice),
    "and",
    createRichTextMentionMarkdown(issue),
    "today."
  ].join(" ");

  assert.deepEqual(extractRichTextMentionsFromContent(content), [alice, issue]);
  assert.equal(
    extractPlainTextFromContent(content),
    "Please sync with @Alice and @Issue 7 today."
  );
});

test("removes only the targeted mention from content", () => {
  const alice = createRichTextMentionAttrs("user", {
    entityId: "u_123",
    label: "Alice"
  });
  const bob = createRichTextMentionAttrs("user", {
    entityId: "u_456",
    label: "Bob"
  });
  const content = `${createRichTextMentionMarkdown(alice)} and ${createRichTextMentionMarkdown(bob)}`;

  assert.equal(
    removeRichTextMentionFromContent(content, {
      providerId: "user",
      entityId: "u_123"
    }),
    "and [@Bob](mention://user/u_456)"
  );
});

test("manages generic markdown link refs without workspace-specific exports", () => {
  const content = appendRichTextLinksToContent("Notes", [
    {
      kind: "file",
      name: "README.md",
      path: "/workspace/docs/README.md"
    },
    {
      kind: "folder",
      name: "docs",
      path: "/workspace/docs"
    }
  ]);

  assert.equal(
    content,
    "Notes [README.md](/workspace/docs/README.md) [docs](/workspace/docs/)"
  );
  assert.deepEqual(extractRichTextLinksFromContent(content), [
    {
      href: "/workspace/docs/README.md",
      kind: "file",
      name: "README.md",
      path: "/workspace/docs/README.md"
    },
    {
      href: "/workspace/docs/",
      kind: "folder",
      name: "docs",
      path: "/workspace/docs/"
    }
  ]);
  assert.equal(
    normalizeRichTextLinkHref("/workspace/docs", "folder"),
    "/workspace/docs/"
  );
  assert.equal(
    removeRichTextLinkFromContent(content, "/workspace/docs/README.md"),
    "Notes [docs](/workspace/docs/)"
  );
});

test("escapes generated workspace link markdown for bracket and paren paths", () => {
  const content = appendRichTextLinksToContent("", [
    {
      kind: "file",
      name: "foo]bar).txt",
      path: "/tmp/foo]bar).txt"
    },
    {
      kind: "file",
      name: "foo(.txt",
      path: "/tmp/foo(.txt"
    }
  ]);

  assert.equal(
    content,
    "[foo\\]bar).txt](/tmp/foo]bar\\).txt) [foo(.txt](/tmp/foo\\(.txt)"
  );
  assert.deepEqual(extractRichTextLinksFromContent(content), [
    {
      href: "/tmp/foo]bar).txt",
      kind: "file",
      name: "foo]bar).txt",
      path: "/tmp/foo]bar).txt"
    },
    {
      href: "/tmp/foo(.txt",
      kind: "file",
      name: "foo(.txt",
      path: "/tmp/foo(.txt"
    }
  ]);
  assert.equal(
    serializeRichTextDocumentToContent(parseRichTextContentToDocument(content)),
    content
  );
});

test("round-trips storage content through the structured document adapter", () => {
  const alice = createRichTextMentionAttrs("user", {
    entityId: "u_123",
    label: "Alice"
  });
  const content = `Summary\n\nSee ${createRichTextMentionMarkdown(alice)} and [docs](/workspace/docs/)`;

  assert.equal(
    serializeRichTextDocumentToContent(parseRichTextContentToDocument(content)),
    content
  );
});

test("keeps colons in mention entity path segments", () => {
  const target = createRichTextMentionAttrs("agent-target", {
    entityId: "local:codex",
    label: "Codex"
  });

  assert.equal(
    createRichTextMentionMarkdown(target),
    "[@Codex](mention://agent-target/local:codex)"
  );
});

test("parses workspace refs with spaces and parentheses in hrefs", () => {
  const content =
    "Files [White House (cropped).jpg](/Users/example/Downloads/White House (cropped).jpg) [html_files](/Users/example/Downloads/html files/)";
  const document = parseRichTextContentToDocument(content);

  assert.deepEqual(extractRichTextLinksFromContent(content), [
    {
      href: "/Users/example/Downloads/White House (cropped).jpg",
      kind: "file",
      name: "White House (cropped).jpg",
      path: "/Users/example/Downloads/White House (cropped).jpg"
    },
    {
      href: "/Users/example/Downloads/html files/",
      kind: "folder",
      name: "html_files",
      path: "/Users/example/Downloads/html files/"
    }
  ]);
  assert.equal(
    document.content?.[0]?.content?.filter(
      (node) => node.type === "workspaceReference"
    ).length,
    2
  );
  assert.equal(
    document.content?.[0]?.content?.at(-1)?.type,
    "workspaceReference"
  );
  assert.equal(
    serializeRichTextDocumentToContent(document),
    "Files [White House (cropped).jpg](/Users/example/Downloads/White House \\(cropped\\).jpg) [html_files](/Users/example/Downloads/html files/)"
  );
  assert.equal(
    removeRichTextLinkFromContent(
      content,
      "/Users/example/Downloads/White House (cropped).jpg"
    ),
    "Files [html_files](/Users/example/Downloads/html files/)"
  );
});

test("keeps non-structured markdown links as plain text in the document adapter", () => {
  const content =
    "Read [OpenAI](https://openai.com) then [docs](/workspace/docs/)";
  const document = parseRichTextContentToDocument(content);

  assert.equal(serializeRichTextDocumentToContent(document), content);
  assert.equal(document.content?.[0]?.content?.[1]?.type, "text");
  assert.equal(
    document.content?.[0]?.content?.at(-1)?.type,
    "workspaceReference"
  );
});
