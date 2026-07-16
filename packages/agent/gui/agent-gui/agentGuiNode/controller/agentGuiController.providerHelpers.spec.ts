import { describe, expect, it } from "vitest";
import type {
  AgentActivityComposerOptions,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import {
  composerOptionsForTarget,
  composerOptionsLoadFailedForTarget,
  composerOptionsLoadingForTarget,
  composerTargetDataFromProviderTarget,
  resolveAgentGUIProviderRailTargetSelection
} from "./agentGuiController.providerHelpers";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentGUINodeData } from "../../../types";

const target = {
  agentTargetId: "target-1"
} as AgentGUIComposerTargetData;

describe("composer options target state", () => {
  it("reports loading only before the target has cached options", () => {
    const loadingSnapshot = snapshot({
      composerOptionsLoadStatusByTargetKey: { "target-1": "loading" }
    });
    expect(
      composerOptionsLoadingForTarget({ snapshot: loadingSnapshot, target })
    ).toBe(true);
    expect(
      composerOptionsForTarget({ snapshot: loadingSnapshot, target })
    ).toBe(null);

    const cachedOptions = {} as AgentActivityComposerOptions;
    const refreshingSnapshot = snapshot({
      composerOptionsByTargetKey: { "target-1": cachedOptions },
      composerOptionsLoadStatusByTargetKey: { "target-1": "loading" }
    });
    expect(
      composerOptionsLoadingForTarget({ snapshot: refreshingSnapshot, target })
    ).toBe(false);
    expect(
      composerOptionsForTarget({ snapshot: refreshingSnapshot, target })
    ).toBe(cachedOptions);
  });

  it("does not leave the target loading after a request error", () => {
    expect(
      composerOptionsLoadingForTarget({
        snapshot: snapshot({
          composerOptionsLoadStatusByTargetKey: { "target-1": "error" }
        }),
        target
      })
    ).toBe(false);
  });

  it("reports a load failure only while no cached options exist", () => {
    expect(
      composerOptionsLoadFailedForTarget({
        snapshot: snapshot({
          composerOptionsLoadStatusByTargetKey: { "target-1": "error" }
        }),
        target
      })
    ).toBe(true);
    expect(
      composerOptionsLoadFailedForTarget({
        snapshot: snapshot({
          composerOptionsByTargetKey: {
            "target-1": {} as AgentActivityComposerOptions
          },
          composerOptionsLoadStatusByTargetKey: { "target-1": "error" }
        }),
        target
      })
    ).toBe(false);
    expect(
      composerOptionsLoadFailedForTarget({
        snapshot: snapshot({
          composerOptionsLoadStatusByTargetKey: { "target-1": "loading" }
        }),
        target
      })
    ).toBe(false);
  });
});

describe("composer target data from provider target", () => {
  const nodeData: AgentGUINodeData = {
    provider: "codex",
    agentTargetId: null,
    lastActiveAgentSessionId: null
  };

  it("never backfills a loading-sentinel target id as an agent target id", () => {
    const targetData = composerTargetDataFromProviderTarget({
      current: nodeData,
      isExplicit: false,
      target: {
        targetId: "__loading__",
        provider: "codex",
        ref: { kind: "loading", provider: "codex" },
        label: "codex",
        disabled: true
      }
    });
    expect(targetData.agentTargetId).toBe(null);
    expect(targetData.data.agentTargetId).toBe(null);
  });

  it("keeps an unresolved node target id out of the sentinel projection", () => {
    const targetData = composerTargetDataFromProviderTarget({
      current: { ...nodeData, agentTargetId: "workspace-agent:stale" },
      isExplicit: false,
      target: {
        targetId: "workspace-agent:stale",
        provider: "codex",
        ref: { kind: "loading", provider: "codex" },
        label: "codex",
        disabled: true
      }
    });
    expect(targetData.agentTargetId).toBe(null);
  });

  it("still backfills the target id for resolved catalog targets", () => {
    const targetData = composerTargetDataFromProviderTarget({
      current: nodeData,
      isExplicit: true,
      target: {
        targetId: "local:codex",
        provider: "codex",
        ref: { kind: "local", provider: "codex" },
        label: "Codex"
      }
    });
    expect(targetData.agentTargetId).toBe("local:codex");
  });
});

describe("provider rail target selection", () => {
  it("keeps an active conversation that belongs to the selected target", () => {
    expect(
      resolveAgentGUIProviderRailTargetSelection({
        activeConversation: conversation(
          "claude-session",
          "local:claude-code",
          "claude-code"
        ),
        nextFilter: {
          kind: "agentTarget",
          agentTargetId: "local:claude-code"
        }
      })
    ).toBe("keep-active-conversation");
  });

  it("opens the selected target home when the active conversation belongs elsewhere", () => {
    expect(
      resolveAgentGUIProviderRailTargetSelection({
        activeConversation: conversation(
          "codex-session",
          "local:codex",
          "codex"
        ),
        nextFilter: {
          kind: "agentTarget",
          agentTargetId: "local:claude-code"
        }
      })
    ).toBe("open-home-composer");
  });

  it("opens the selected target home when there is no active conversation", () => {
    expect(
      resolveAgentGUIProviderRailTargetSelection({
        activeConversation: null,
        nextFilter: {
          kind: "agentTarget",
          agentTargetId: "local:claude-code"
        }
      })
    ).toBe("open-home-composer");
  });

  it("opens the selected target home when it has no agent target id", () => {
    expect(
      resolveAgentGUIProviderRailTargetSelection({
        activeConversation: conversation(
          "codex-session",
          "local:codex",
          "codex"
        ),
        nextFilter: { kind: "all" }
      })
    ).toBe("open-home-composer");
  });
});

function snapshot(
  overrides: Partial<AgentActivitySnapshot>
): AgentActivitySnapshot {
  return {
    workspaceId: "workspace-1",
    sessions: [],
    presences: [],
    sessionMessagesById: {},
    ...overrides
  };
}

function conversation(
  id: string,
  agentTargetId: string,
  provider: AgentGUIConversationSummary["provider"]
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
