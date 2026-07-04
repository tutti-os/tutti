import { describe, expect, it } from "vitest";
import type { WorkspaceAgentActivitySession } from "../../../shared/workspaceAgentActivityTypes.ts";
import type { AgentGUIConversationSummary } from "./agentGuiConversationModel.ts";
import {
  createAgentGUIConversationFilterState,
  filterAgentGUIConversationSummaries,
  filterWorkspaceAgentActivitySessionsForConversations
} from "./agentGuiConversationFilter.ts";

describe("agentGuiConversationFilter", () => {
  it("does not constrain sessions by agent target for the all filter", () => {
    expect(
      filterWorkspaceAgentActivitySessionsForConversations(
        [
          session("codex-local", "local:codex"),
          session("codex-shared", "shared:codex"),
          session("targetless", null)
        ],
        { kind: "all" }
      ).map((item) => item.agentSessionId)
    ).toEqual(["codex-local", "codex-shared", "targetless"]);
  });

  it("filters summaries by the selected agent target only", () => {
    expect(
      filterAgentGUIConversationSummaries(
        [
          conversation("codex-local", "local:codex"),
          conversation("codex-shared", "shared:codex"),
          conversation("targetless", null)
        ],
        { kind: "agentTarget", agentTargetId: "local:codex" }
      ).map((item) => item.id)
    ).toEqual(["codex-local"]);
  });

  it("keeps the filter model independent from composer state", () => {
    const composerState = Object.freeze({
      defaultProviderTargetId: "local:codex",
      selectedProviderTarget: "local:codex"
    });

    const filterState = createAgentGUIConversationFilterState({
      kind: "agentTarget",
      agentTargetId: "local:claude-code"
    });

    expect(filterState).toEqual({
      filter: {
        kind: "agentTarget",
        agentTargetId: "local:claude-code"
      }
    });
    expect(filterState).not.toHaveProperty("defaultProviderTargetId");
    expect(filterState).not.toHaveProperty("selectedProviderTarget");
    expect(composerState).toEqual({
      defaultProviderTargetId: "local:codex",
      selectedProviderTarget: "local:codex"
    });
  });
});

function session(
  agentSessionId: string,
  agentTargetId: string | null
): WorkspaceAgentActivitySession {
  return {
    agentSessionId,
    agentTargetId,
    cwd: "/repo",
    provider: "codex",
    status: "completed",
    title: agentSessionId,
    updatedAtUnixMs: 1,
    workspaceId: "workspace-1"
  };
}

function conversation(
  id: string,
  agentTargetId: string | null
): AgentGUIConversationSummary {
  return {
    id,
    agentTargetId,
    cwd: "/repo",
    provider: "codex",
    status: "completed",
    title: id,
    updatedAtUnixMs: 1
  };
}
