import { describe, expect, it } from "vitest";
import {
  AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
  agentGUIConversationRailScopedViewState,
  agentGUIConversationRailViewScopeKey,
  reduceAgentGUIConversationRailViewState
} from "./agentGuiConversationRailViewState";

describe("agent GUI conversation rail view state", () => {
  it("keys durable view state by workspace and exact target", () => {
    expect(
      agentGUIConversationRailViewScopeKey({
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: " local:codex "
        },
        sectionAgentTargetFallbackId: null,
        workspaceId: " workspace-1 "
      })
    ).toBe("workspace-1:agentTarget:local:codex");
    expect(
      agentGUIConversationRailViewScopeKey({
        conversationFilter: { kind: "all" },
        sectionAgentTargetFallbackId: "local:claude-code",
        workspaceId: "workspace-1"
      })
    ).toBe("workspace-1:all:local:claude-code");
  });

  it("keeps collapsed sections and visible limits independent by scope", () => {
    let state = reduceAgentGUIConversationRailViewState(new Map(), {
      type: "section-collapsed-toggled",
      scopeKey: "codex",
      sectionId: "project-1"
    });
    state = reduceAgentGUIConversationRailViewState(state, {
      type: "section-visible-limit-set",
      limit: 15,
      scopeKey: "codex",
      sectionId: "project-1"
    });

    expect(
      agentGUIConversationRailScopedViewState(
        state,
        "codex"
      ).collapsedSectionIds.has("project-1")
    ).toBe(true);
    expect(
      agentGUIConversationRailScopedViewState(
        state,
        "codex"
      ).visibleItemLimitBySectionId.get("project-1")
    ).toBe(15);
    expect(
      agentGUIConversationRailScopedViewState(
        state,
        "claude"
      ).visibleItemLimitBySectionId.get("project-1") ??
        AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE
    ).toBe(5);
  });
});
