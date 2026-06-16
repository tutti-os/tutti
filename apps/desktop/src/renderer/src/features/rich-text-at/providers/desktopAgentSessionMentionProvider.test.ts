import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRichTextAtProvider } from "@tutti-os/agent-gui/agent-rich-text-at-provider";
import { createDesktopAgentSessionMentionProvider } from "./desktopAgentSessionMentionProvider.ts";

interface FakeSessionItem {
  readonly id: string;
  readonly meta: Record<string, string>;
}

function createBaseSessionProvider(): AgentRichTextAtProvider<FakeSessionItem> {
  return {
    id: "agent-session",
    getItemKey: (item) => item.id,
    getItemLabel: (item) => item.meta.title ?? item.id,
    getItemSubtitle: (item) => item.meta.status ?? "",
    query: async () => [],
    toInsertResult: (item) => ({
      kind: "mention",
      mention: {
        entityId: item.id,
        href: `mention://agent-session?id=${item.id}`,
        kind: "agent-session",
        label: item.meta.title ?? item.id,
        meta: item.meta
      }
    })
  };
}

const RESOLVERS = {
  resolveAgentIconUrl: (provider: string) => `icon://${provider}`,
  userAvatarPlaceholderUrl: "asset://user-avatar-placeholder.png",
  resolveStatusView: (status: string) =>
    status === "working"
      ? { dataStatus: "working", label: "Working", pulse: true }
      : { dataStatus: status, label: status, pulse: false }
};

test("agent session mention provider enriches meta with avatars, participant, and status", () => {
  const provider = createDesktopAgentSessionMentionProvider({
    baseProvider:
      createBaseSessionProvider(),
    ...RESOLVERS
  });

  const insertResult = provider.toInsertResult({
    id: "session-1",
    meta: {
      agentName: "Codex",
      initiatorName: "wang jomes",
      provider: "codex",
      status: "working",
      title: "wang jomes & Codex hi"
    }
  });

  assert.equal(insertResult.kind, "mention");
  if (insertResult.kind !== "mention") {
    return;
  }
  const meta = insertResult.mention.meta ?? {};
  assert.equal(meta.participant, "wang jomes & Codex");
  assert.equal(meta.agentIconUrl, "icon://codex");
  assert.equal(
    meta.userAvatarPlaceholderUrl,
    "asset://user-avatar-placeholder.png"
  );
  assert.equal(meta.statusDataStatus, "working");
  assert.equal(meta.statusLabel, "Working");
  assert.equal(meta.statusPulse, "true");
  // Base meta is preserved.
  assert.equal(meta.provider, "codex");
  assert.equal(meta.title, "wang jomes & Codex hi");
});

test("agent session mention provider omits status fields when status is absent", () => {
  const provider = createDesktopAgentSessionMentionProvider({
    baseProvider:
      createBaseSessionProvider(),
    ...RESOLVERS
  });

  const insertResult = provider.toInsertResult({
    id: "session-2",
    meta: {
      agentName: "Codex",
      initiatorName: "wang jomes",
      provider: "codex",
      title: "session two"
    }
  });

  assert.equal(insertResult.kind, "mention");
  if (insertResult.kind !== "mention") {
    return;
  }
  const meta = insertResult.mention.meta ?? {};
  assert.equal(meta.statusDataStatus, undefined);
  assert.equal(meta.statusLabel, undefined);
  assert.equal(meta.statusPulse, undefined);
  assert.equal(meta.participant, "wang jomes & Codex");
  assert.equal(meta.agentIconUrl, "icon://codex");
});
