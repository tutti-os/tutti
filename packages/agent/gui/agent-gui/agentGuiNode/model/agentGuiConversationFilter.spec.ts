import { describe, expect, it } from "vitest";
import {
  normalizeAgentActivitySession,
  type AgentActivitySession
} from "@tutti-os/agent-activity-core";
import type { AgentGUIConversationSummary } from "./agentGuiConversationModel.ts";
import type { AgentGUIResolvedProvider } from "../../../shared/agentConversationTitleProjection.ts";
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
          conversation("codex-local", "local:codex", "codex"),
          conversation("codex-shared", "shared:codex", "codex"),
          conversation("targetless", null, "codex")
        ],
        { kind: "agentTarget", agentTargetId: "local:codex" }
      ).map((item) => item.id)
    ).toEqual(["codex-local", "targetless"]);
  });

  it("matches legacy provider-only sessions to local system agent targets", () => {
    expect(
      filterAgentGUIConversationSummaries(
        [
          conversation("cursor-legacy", null, "cursor"),
          conversation("codex-legacy", null, "codex"),
          conversation("cursor-tagged", "local:cursor", "cursor")
        ],
        { kind: "agentTarget", agentTargetId: "local:cursor" }
      ).map((item) => item.id)
    ).toEqual(["cursor-legacy", "cursor-tagged"]);
  });

  it("keeps the filter model independent from composer state", () => {
    const composerState = Object.freeze({
      defaultAgentTargetId: "local:codex",
      selectedAgentTarget: "local:codex"
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
    expect(filterState).not.toHaveProperty("defaultAgentTargetId");
    expect(filterState).not.toHaveProperty("selectedAgentTarget");
    expect(composerState).toEqual({
      defaultAgentTargetId: "local:codex",
      selectedAgentTarget: "local:codex"
    });
  });
});

function session(
  agentSessionId: string,
  agentTargetId: string | null
): AgentActivitySession {
  return normalizeAgentActivitySession({
    agentSessionId,
    agentTargetId,
    cwd: "/repo",
    provider: "codex",
    title: agentSessionId,
    updatedAtUnixMs: 1,
    workspaceId: "workspace-1"
  });
}

function conversation(
  id: string,
  agentTargetId: string | null,
  provider: AgentGUIResolvedProvider = "codex"
): AgentGUIConversationSummary {
  return {
    id,
    agentTargetId,
    cwd: "/repo",
    provider,
    status: "completed",
    title: id,
    updatedAtUnixMs: 1
  };
}
