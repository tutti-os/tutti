import assert from "node:assert/strict";
import test from "node:test";
import type { AgentContextMentionProvider } from "@tutti-os/agent-gui/context-mention-provider";
import { createDesktopAgentSessionMentionProvider } from "./desktopAgentSessionMentionProvider.ts";

interface FakeSessionItem {
  readonly id: string;
  readonly meta: Record<string, string>;
}

function createBaseSessionProvider(): AgentContextMentionProvider<FakeSessionItem> {
  return {
    id: "agent-session",
    trigger: "@",
    getItemKey: (item) => item.id,
    getItemLabel: (item) => item.meta.title ?? item.id,
    getItemSubtitle: (item) => item.meta.status ?? "",
    query: async () => [],
    toInsertResult: (item) => ({
      kind: "mention",
      mention: {
        entityId: item.id,
        label: item.meta.title ?? item.id,
        presentation: {
          participant: [item.meta.initiatorName, item.meta.agentName]
            .map((value) => value?.trim() ?? "")
            .filter(Boolean)
            .join(" & "),
          status: item.meta.status,
          subtitle: item.meta.provider
        }
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

test("agent session mention provider enriches presentation with avatars, participant, and status", () => {
  const provider = createDesktopAgentSessionMentionProvider({
    baseProvider: createBaseSessionProvider(),
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
  const presentation = insertResult.mention.presentation ?? {};
  assert.equal(presentation.participant, "wang jomes & Codex");
  assert.equal(presentation.agentIconUrl, "icon://codex");
  assert.equal(
    presentation.userAvatarPlaceholderUrl,
    "asset://user-avatar-placeholder.png"
  );
  assert.equal(presentation.statusDataStatus, "working");
  assert.equal(presentation.statusLabel, "Working");
  assert.equal(presentation.statusPulse, "true");
  assert.equal(presentation.subtitle, "codex");
});

test("agent session mention provider omits status fields when status is absent", () => {
  const provider = createDesktopAgentSessionMentionProvider({
    baseProvider: createBaseSessionProvider(),
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
  const presentation = insertResult.mention.presentation ?? {};
  assert.equal(presentation.statusDataStatus, undefined);
  assert.equal(presentation.statusLabel, undefined);
  assert.equal(presentation.statusPulse, undefined);
  assert.equal(presentation.participant, "wang jomes & Codex");
  assert.equal(presentation.agentIconUrl, "icon://codex");
});
