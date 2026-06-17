import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAgentSessionMentionHref,
  buildWorkspaceAppFactoryMentionHref,
  buildWorkspaceAppMentionHref,
  buildWorkspaceIssueMentionHref,
  parseMentionMarkdown,
  parseMentionMarkdownHref
} from "./mentionHref.ts";

test("mention href round-trips agent-session", () => {
  const href = buildAgentSessionMentionHref("ws1", "sess1", "codex");
  assert.equal(
    href,
    "mention://agent-session?workspaceId=ws1&id=sess1&provider=codex"
  );
  const parsed = parseMentionMarkdownHref(href, "Label");
  assert.equal(parsed?.kind, "session");
  assert.equal(parsed?.workspaceId, "ws1");
});

test("mention href round-trips workspace-app", () => {
  const href = buildWorkspaceAppMentionHref("ws1", "ai-media-canvas");
  assert.equal(
    href,
    "mention://workspace-app?workspaceId=ws1&appId=ai-media-canvas"
  );
  assert.equal(parseMentionMarkdownHref(href, "App")?.kind, "workspace-app");
});

test("mention href round-trips workspace-issue", () => {
  const href = buildWorkspaceIssueMentionHref("ws1", "iss1");
  assert.equal(href, "mention://workspace-issue?workspaceId=ws1&id=iss1");
  assert.equal(
    parseMentionMarkdownHref(href, "Issue")?.kind,
    "workspace-issue"
  );
});

test("mention href builds workspace-app-factory without params", () => {
  assert.equal(
    buildWorkspaceAppFactoryMentionHref(),
    "mention://workspace-app-factory"
  );
});

test("mention markdown parser keeps file links without at prefix", () => {
  assert.deepEqual(parseMentionMarkdown("[README.md](/workspace/README.md)"), {
    item: {
      kind: "file",
      href: "/workspace/README.md",
      path: "/workspace/README.md",
      name: "README.md",
      entryKind: "unknown",
      directoryPath: "/workspace"
    },
    end: 33
  });
});
