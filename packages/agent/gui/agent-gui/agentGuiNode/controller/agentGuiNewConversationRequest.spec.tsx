import { act, renderHook, waitFor } from "@testing-library/react";
import {
  createAgentSessionEngine,
  type AgentActivityRailPlacement,
  type EngineExternalCommand
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import { createLocalAgentGUIAgentTarget } from "../../../agentTargets";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentHostUserProject } from "../../../host/agentHostApi";
import type { AgentGUINodeData } from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import { requestAgentGUINewConversation } from "./agentGuiNewConversationRequest";
import { useAgentGUIActivation } from "./useAgentGUIActivation";
import { useAgentGUIConversationHome } from "./useAgentGUIConversationHome";
import { useAgentGUINewConversationActivation } from "./useAgentGUINewConversationActivation";
import { useAgentGUISubmitInteractionActions } from "./useAgentGUISubmitInteractionActions";

describe("P0 new-conversation placement scenarios", () => {
  it("creates a conversations-scoped activation from an active Chats session", async () => {
    const previousSessionCwd = "/Users/example/Documents/tutti/session-current";
    const scenario = renderNewConversationScenario({
      activeConversation: conversationSummary({
        cwd: previousSessionCwd,
        railSectionKey: "conversations"
      }),
      initialHomeProjectPath: previousSessionCwd,
      userProjects: []
    });

    act(() => scenario.requestNewConversation());
    act(() =>
      scenario.submitPrompt([{ type: "text", text: "start a new chat" }])
    );

    const activation = await scenario.waitForActivation();
    expect(activation).toMatchObject({
      cwd: "",
      initialContent: [{ type: "text", text: "start a new chat" }],
      railPlacement: {
        version: 1,
        kind: "conversations",
        sectionKey: "conversations"
      }
    });
    expect(activation.cwd).not.toBe(previousSessionCwd);
  });

  it("keeps canonical project placement when starting from a project session", async () => {
    const projectPath = "/workspace/project-a";
    const sectionKey = "project:workspace-1:/workspace/project-a";
    const scenario = renderNewConversationScenario({
      activeConversation: conversationSummary({
        cwd: projectPath,
        railSectionKey: sectionKey
      }),
      initialHomeProjectPath: null,
      userProjects: [
        {
          id: "project-a",
          label: "Project A",
          path: projectPath,
          pinnedAtUnixMs: 0,
          sectionKey
        }
      ]
    });

    act(() => scenario.requestNewConversation());
    act(() =>
      scenario.submitPrompt([{ type: "text", text: "continue in project" }])
    );

    expect(await scenario.waitForActivation()).toMatchObject({
      cwd: projectPath,
      initialContent: [{ type: "text", text: "continue in project" }],
      railPlacement: {
        version: 1,
        kind: "project",
        projectPath,
        sectionKey
      }
    });
  });

  it("preserves an explicit project selection already made on Home", async () => {
    const projectPath = "/workspace/project-a";
    const sectionKey = "project:workspace-1:/workspace/project-a";
    const scenario = renderNewConversationScenario({
      activeConversation: null,
      initialHomeProjectPath: projectPath,
      userProjects: [
        {
          id: "project-a",
          label: "Project A",
          path: projectPath,
          pinnedAtUnixMs: 0,
          sectionKey
        }
      ]
    });

    act(() => scenario.requestNewConversation());
    act(() =>
      scenario.submitPrompt([{ type: "text", text: "start in my project" }])
    );

    expect(await scenario.waitForActivation()).toMatchObject({
      cwd: projectPath,
      initialContent: [{ type: "text", text: "start in my project" }],
      railPlacement: {
        version: 1,
        kind: "project",
        projectPath,
        sectionKey
      }
    });
  });
});

function renderNewConversationScenario(input: {
  activeConversation: AgentGUIConversationSummary | null;
  initialHomeProjectPath: string | null;
  userProjects: AgentHostUserProject[];
}) {
  const commands: EngineExternalCommand[] = [];
  const sessionEngine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 1 },
    commandPort: {
      execute: (command) => {
        commands.push(command);
        return new Promise<never>(() => {});
      }
    },
    identity: { origin: "test", workspaceId: "workspace-1" },
    scheduler: { schedule: () => ({ cancel() {} }) }
  });
  const target = createLocalAgentGUIAgentTarget("codex");
  const dataRef: { current: AgentGUINodeData } = {
    current: {
      agentTargetId: target.agentTargetId,
      lastActiveAgentSessionId: input.activeConversation?.id ?? null,
      provider: "codex" as const
    }
  };
  const targetData: AgentGUIComposerTargetData = {
    agentTargetId: target.agentTargetId ?? null,
    data: dataRef.current,
    provider: "codex",
    targetId: target.targetId
  };
  const activeConversationIdRef = {
    current: input.activeConversation?.id ?? null
  };
  const isComposerHomeRef = { current: input.activeConversation === null };
  const selectedProjectPathRef = {
    current: input.initialHomeProjectPath
  };
  const draftByScopeKeyRef = {
    current: {} as Record<string, AgentComposerDraft>
  };
  const submittedDraftSnapshotsRef = { current: {} };
  const agentActivityRuntime = {} as AgentActivityRuntime;
  const setDraftByScopeKey = vi.fn();
  const conversationsRef = {
    current: input.activeConversation ? [input.activeConversation] : []
  };
  const conversationListQuery = {
    provider: "codex" as const,
    sessionOrigin: "local",
    userId: "user-1",
    workspaceId: "workspace-1"
  };

  const { result } = renderHook(() => {
    const activation = useAgentGUIActivation({
      engine: sessionEngine,
      getErrorMessage: (error) => String(error),
      workspaceId: "workspace-1"
    });
    const { createConversation } = useAgentGUIConversationHome({
      activeConversationIdRef,
      activePendingActivation: null,
      agentActivityRuntime,
      composerAppendRequest: null,
      composerTargetDataFromProviderTarget: () => targetData,
      conversationFilterRef: { current: { kind: "all" } },
      currentProvider: "codex",
      dataRef,
      defaultAgentTargetId: target.agentTargetId ?? null,
      draftByScopeKeyRef,
      handledComposerAppendSequenceRef: { current: null },
      handledPrefillPromptSequenceRef: { current: null },
      isComposerHomeRef,
      isExplicitAgentGUIAgentTarget: () => true,
      loadDraftComposerOptions: vi.fn(),
      normalizedExplicitProviderTargets: [target],
      normalizedProviderTargets: [target],
      onDataChangeRef: {
        current: (updater) => {
          dataRef.current = updater(dataRef.current);
        }
      },
      persistActiveConversation: vi.fn(),
      prefillPromptRequest: null,
      reportActiveConversationCleared: vi.fn(),
      selectedComposerTargetDataRef: { current: targetData },
      selectedProjectPathRef,
      setActiveConversationId: vi.fn(),
      setConversationFilter: vi.fn(),
      setDetailError: vi.fn(),
      setDraftByScopeKey,
      setHomeComposerTargetOverride: vi.fn(),
      setIntent: vi.fn(),
      setIsComposerHome: vi.fn(),
      setIsLoadingMessages: vi.fn(),
      setSelectedProjectPath: vi.fn(),
      shouldUseStaticProviderTargets: true,
      submitPrefillPrompt: vi.fn(),
      unactivate: async () => undefined,
      workspaceId: "workspace-1"
    });
    const startConversation = useAgentGUINewConversationActivation({
      activation,
      activeConversationIdRef,
      activeSessionState: null,
      agentActivityRuntime,
      agentTargetsProvidedRef: { current: true },
      conversationListQuery,
      conversationsRef,
      currentUserId: "user-1",
      data: dataRef.current,
      defaultReasoningEffort: "high",
      draftByScopeKeyRef,
      draftSettingsBySessionIdRef: { current: {} },
      getCachedComposerOptions: () => null,
      isComposerHomeRef,
      isConversationStale: () => false,
      isCreatingConversationRef: { current: false },
      isCurrentConversation: () => false,
      loadSelectedConversationMessages: async () => undefined,
      loadSessionState: vi.fn(),
      onDataChangeRef: {
        current: (updater) => {
          dataRef.current = updater(dataRef.current);
        }
      },
      persistActiveConversation: vi.fn(),
      refreshMessagesFromSnapshot: vi.fn(),
      requestRailReveal: vi.fn(),
      selectedAgentTargetIsExplicitRef: { current: true },
      selectedAgentTargetRef: { current: target },
      selectedComposerTargetDataRef: { current: targetData },
      selectedProjectPathRef,
      sessionEngine,
      setActiveConversationId: vi.fn(),
      setDetailError: vi.fn(),
      setIntent: vi.fn(),
      setIsComposerHome: vi.fn(),
      setIsLoadingMessages: vi.fn(),
      submittedDraftSnapshotsRef,
      syncConversationListProjection: async () => undefined,
      tuttiModeDraftKey: "node-default:codex:local:codex",
      userProjectsRef: { current: input.userProjects },
      workspaceId: "workspace-1"
    });
    const { submitPrompt } = useAgentGUISubmitInteractionActions({
      activation,
      activeConversationIdRef,
      activeEngineActiveTurn: null,
      activeEnginePendingInteractions: [],
      agentActivityRuntime,
      conversationListQuery,
      conversationsRef,
      dataRef,
      draftByScopeKeyRef,
      executePromptRef: { current: vi.fn() },
      isComposerHomeRef,
      isCurrentConversation: () => false,
      isRespondingToInteraction: false,
      isSessionMarkedNonResumable: () => false,
      optimisticGoalControl: null,
      persistActiveConversation: vi.fn(),
      planActionsRef: {
        current: {
          feedback: vi.fn(),
          implement: vi.fn(),
          skip: vi.fn()
        }
      },
      promptImagesSupported: true,
      sessionEngine,
      setActiveConversationId: vi.fn(),
      setDetailError: vi.fn(),
      setDraftByScopeKey,
      setGoalClearNoticeSequence: vi.fn(),
      setIntent: vi.fn(),
      setOptimisticGoalControl: vi.fn(),
      startConversation,
      submitPromptRef: { current: vi.fn() },
      submittedDraftSnapshotsRef,
      transientConversation: null,
      workspaceId: "workspace-1"
    });
    return { createConversation, submitPrompt };
  });

  return {
    requestNewConversation() {
      requestAgentGUINewConversation({
        activeConversationId: activeConversationIdRef.current,
        conversations: conversationsRef.current,
        createConversation: result.current.createConversation,
        transientConversation: null
      });
    },
    submitPrompt: result.current.submitPrompt,
    async waitForActivation() {
      let activation: EngineExternalCommand | undefined;
      await waitFor(() => {
        const matches = commands.filter(
          (command) => command.type === "session/activate"
        );
        expect(matches).toHaveLength(1);
        activation = matches[0];
      });
      return activation as EngineExternalCommand & {
        cwd: string;
        railPlacement: AgentActivityRailPlacement;
      };
    }
  };
}

function conversationSummary(input: {
  cwd: string;
  railSectionKey: string;
}): AgentGUIConversationSummary {
  return {
    id: "session-current",
    provider: "codex",
    title: "Current conversation",
    status: "ready",
    cwd: input.cwd,
    railSectionKey: input.railSectionKey,
    updatedAtUnixMs: 1
  };
}
