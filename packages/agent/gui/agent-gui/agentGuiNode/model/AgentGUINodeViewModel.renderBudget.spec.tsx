import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentGUINodeViewModel } from "./agentGuiNodeTypes";
import { useAgentGUIViewModel } from "./useAgentGUIViewModel";
import { buildAgentComposerDraft } from "./agentComposerDraft";

describe("useAgentGUIViewModel render budgets", () => {
  it("keeps composer and rail references stable for a streaming detail update", () => {
    assertIsolatedGroupUpdate("detail", ["composer", "rail"]);
  });

  it("keeps detail and composer references stable for a rail interaction", () => {
    assertIsolatedGroupUpdate("rail", ["composer", "detail"]);
  });

  it("keeps rail and detail references stable while typing in the composer", () => {
    assertIsolatedGroupUpdate("composer", ["detail", "rail"]);
  });
});

function assertIsolatedGroupUpdate(
  group: "composer" | "detail" | "rail",
  stableGroups: readonly ("composer" | "detail" | "rail")[]
): void {
  const initial = createViewModel();
  const rendered = renderHook(
    ({ candidate }) => useAgentGUIViewModel(candidate),
    { initialProps: { candidate: initial } }
  );
  const previous = rendered.result.current;

  rendered.rerender({
    candidate: {
      ...initial,
      [group]: changedGroup(group, initial[group])
    }
  });

  expect(rendered.result.current[group]).not.toBe(previous[group]);
  for (const stableGroup of stableGroups) {
    expect(rendered.result.current[stableGroup]).toBe(previous[stableGroup]);
  }
}

function changedGroup<Group extends "composer" | "detail" | "rail">(
  group: Group,
  current: AgentGUINodeViewModel[Group]
): AgentGUINodeViewModel[Group] {
  if (group === "detail") {
    return {
      ...current,
      backgroundAgentCount:
        (current as AgentGUINodeViewModel["detail"]).backgroundAgentCount + 1
    } as AgentGUINodeViewModel[Group];
  }
  if (group === "rail") {
    return {
      ...current,
      isLoadingConversations: !(current as AgentGUINodeViewModel["rail"])
        .isLoadingConversations
    } as AgentGUINodeViewModel[Group];
  }
  return {
    ...current,
    draftPrompt: `${(current as AgentGUINodeViewModel["composer"]).draftPrompt}x`
  } as AgentGUINodeViewModel[Group];
}

function createViewModel(): AgentGUINodeViewModel {
  return {
    shell: {
      workspaceId: "workspace-1",
      workspacePath: "/workspace",
      currentUserId: "user-1",
      data: {} as AgentGUINodeViewModel["shell"]["data"]
    },
    rail: {
      selectedAgentTarget:
        {} as AgentGUINodeViewModel["rail"]["selectedAgentTarget"],
      agentTargets: [],
      agentTargetsLoading: false,
      providerRailMode: "catalog",
      comingSoonProviders: [],
      conversationFilter: { kind: "all" },
      conversations: [],
      userProjects: [],
      activeConversation: null,
      activeConversationId: null,
      isLoadingConversations: false,
      listError: null
    },
    detail: {
      availability: "ready",
      isLoadingMessages: false,
      isLoadingOlderMessages: false,
      hasOlderMessages: false,
      usage: null,
      backgroundAgentCount: 0,
      hasSentUserMessage: false,
      avoidGroupingEdits: false,
      conversation: null,
      conversationDetail: null
    },
    composer: {
      handoffAgentTargets: [],
      availableCommands: [],
      availableSkills: [],
      draftPrompt: "",
      draftContent: buildAgentComposerDraft({ prompt: "" }),
      isCreatingConversation: false,
      isSubmitting: false,
      isInterrupting: false,
      isCancelPending: false,
      promptImagesSupported: false,
      compactSupported: false,
      goalPauseSupported: false,
      canSubmit: false,
      composerSettings:
        {} as AgentGUINodeViewModel["composer"]["composerSettings"],
      queuedPrompts: [],
      drainingQueuedPromptId: null,
      canQueueWhileBusy: false
    },
    interaction: {} as AgentGUINodeViewModel["interaction"],
    readiness: {} as AgentGUINodeViewModel["readiness"],
    operations: {} as AgentGUINodeViewModel["operations"]
  };
}
