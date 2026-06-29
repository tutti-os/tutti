import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGUINodeData, NodeFrame } from "../../types";
import type {
  AgentComposerDraft,
  AgentGUINodeViewModel
} from "./model/agentGuiNodeTypes";
import { AgentGUINode } from "./AgentGUINode";

const { agentGuiNodeViewSpy } = vi.hoisted(() => ({
  agentGuiNodeViewSpy: vi.fn()
}));

let mockViewModel: AgentGUINodeViewModel;

vi.mock("../../i18n/index", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "agentHost.workspaceAgentSessionDetailToolCalls") {
        return `${options?.count ?? 0} tool calls`;
      }
      return key;
    }
  })
}));

vi.mock("./controller/useAgentGUINodeController", () => ({
  useAgentGUINodeController: () => ({
    viewModel: mockViewModel,
    actions: {
      createConversation: vi.fn(),
      selectConversation: vi.fn(),
      submitPrompt: vi.fn(),
      submitGuidancePrompt: vi.fn(),
      showPromptImagesUnsupported: vi.fn(),
      submitApprovalOption: vi.fn(),
      submitInteractivePrompt: vi.fn(),
      interruptCurrentTurn: vi.fn(),
      updateDraftContent: vi.fn(),
      updateComposerSettings: vi.fn(),
      sendQueuedPromptNext: vi.fn(),
      removeQueuedPrompt: vi.fn(),
      editQueuedPrompt: vi.fn(),
      removeProject: vi.fn(),
      confirmDeleteProjectConversations: vi.fn(),
      requestDeleteConversation: vi.fn(),
      retryActivation: vi.fn(),
      continueInNewConversation: vi.fn(),
      retryOpenclawGateway: vi.fn(),
      cancelDeleteConversation: vi.fn(),
      confirmDeleteConversation: vi.fn()
    }
  })
}));

vi.mock("./AgentGUINodeView", () => ({
  AgentGUINodeView: (props: unknown) => {
    agentGuiNodeViewSpy(props);
    return <div data-testid="agent-gui-view" />;
  }
}));

vi.mock("../shared/WorkspaceNodeWindow", () => ({
  WorkspaceNodeWindow: ({
    children,
    width,
    height
  }: {
    children: (frame: {
      size: { width: number; height: number };
    }) => React.ReactNode;
    width: number;
    height: number;
  }) => <div>{children({ size: { width, height } })}</div>
}));

vi.mock("../shared/CanvasNodeGhostIconButton", () => ({
  CanvasNodeGhostIconButton: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  )
}));

vi.mock("../shared/canvasNodeChromeIcons", () => ({
  CanvasNodePanelLinedIcon: () => <span data-testid="panel-icon" />
}));

vi.mock("../workspaceDesktop/view/AgentProbeInfoPopover", () => ({
  AgentProbeInfoPopover: () => <div data-testid="agent-probe-popover" />
}));

describe("AgentGUINode memoization", () => {
  afterEach(() => {
    agentGuiNodeViewSpy.mockReset();
  });

  it("does not rerender when another provider probe changes", () => {
    mockViewModel = createViewModel();
    const props = createProps();
    const { rerender } = render(<AgentGUINode {...props} />);

    expect(agentGuiNodeViewSpy).toHaveBeenCalledTimes(1);
    agentGuiNodeViewSpy.mockClear();

    rerender(
      <AgentGUINode
        {...props}
        workspaceAgentProbes={{
          snapshot: {
            workspaceId: "workspace-1",
            capturedAtUnixMs: 2,
            providers: [
              {
                provider: "gemini",
                availability: { status: "unavailable", detailsVisible: false },
                lastError: { code: "auth_required", message: "Sign in again" }
              }
            ]
          },
          isLoadingAvailability: false,
          isLoadingUsage: false
        }}
      />
    );

    expect(agentGuiNodeViewSpy).not.toHaveBeenCalled();
  });

  it("rerenders when its own provider probe changes", () => {
    mockViewModel = createViewModel();
    const props = createProps({
      workspaceAgentProbes: {
        snapshot: {
          workspaceId: "workspace-1",
          capturedAtUnixMs: 1,
          providers: [
            {
              provider: "codex",
              availability: { status: "available", detailsVisible: false }
            }
          ]
        },
        isLoadingAvailability: false,
        isLoadingUsage: false
      }
    });
    const { rerender } = render(<AgentGUINode {...props} />);

    expect(agentGuiNodeViewSpy).toHaveBeenCalledTimes(1);
    agentGuiNodeViewSpy.mockClear();

    rerender(
      <AgentGUINode
        {...props}
        workspaceAgentProbes={{
          snapshot: {
            workspaceId: "workspace-1",
            capturedAtUnixMs: 2,
            providers: [
              {
                provider: "codex",
                availability: { status: "unavailable", detailsVisible: false },
                lastError: { code: "auth_required", message: "Sign in again" }
              }
            ]
          },
          isLoadingAvailability: false,
          isLoadingUsage: false
        }}
      />
    );

    expect(agentGuiNodeViewSpy).toHaveBeenCalledTimes(1);
  });
});

function createProps(
  overrides: Partial<Parameters<typeof AgentGUINode>[0]> = {}
): Parameters<typeof AgentGUINode>[0] {
  return {
    nodeId: "agent-gui-1",
    workspaceId: "room-1",
    currentUserId: "user-1",
    workspacePath: "/workspace",
    agentSettings: { avoidGroupingEdits: false },
    title: "Codex",
    state: createState(),
    position: { x: 80, y: 56 },
    width: 880,
    height: 520,
    desktopSize: { width: 1280, height: 720 },
    isActive: true,
    onClose: vi.fn(),
    onResize: vi.fn<(frame: NodeFrame) => void>(),
    onUpdateNode: vi.fn(),
    ...overrides
  };
}

function createState(
  overrides: Partial<AgentGUINodeData> = {}
): AgentGUINodeData {
  return {
    provider: "codex",
    lastActiveAgentSessionId: null,
    conversationRailWidthPx: null,
    conversationRailCollapsed: false,
    ...overrides
  };
}

function createViewModel(
  overrides: Partial<AgentGUINodeViewModel> = {}
): AgentGUINodeViewModel {
  const draftContent: AgentComposerDraft = { prompt: "", images: [] };
  return {
    workspaceId: "room-1",
    data: createState(),
    activeConversationId: null,
    activeConversation: null,
    conversations: [],
    userProjects: [],
    conversation: null,
    conversationDetail: null,
    draftPrompt: "",
    draftContent,
    sessionChrome: {
      auth: null,
      approval: null,
      recovery: null,
      rawState: null
    },
    pendingInteractivePrompt: null,
    queuedPrompts: [],
    canSubmit: true,
    canQueueWhileBusy: false,
    isSubmitting: false,
    isInterrupting: false,
    promptImagesSupported: true,
    listError: null,
    isCreatingConversation: false,
    isLoadingConversations: false,
    isLoadingMessages: false,
    detailError: null,
    deletingConversationId: null,
    deletingConversationTitle: null,
    composerSettings: {
      sessionSettings: null,
      draftSettings: {
        model: null,
        reasoningEffort: null,
        planMode: false,
        permissionModeId: "full-access"
      },
      defaultModel: null,
      defaultReasoningEffort: null,
      supportsModel: false,
      supportsReasoningEffort: true,
      supportsPlanMode: true,
      isSettingsLoading: false,
      modelUnavailable: false,
      reasoningUnavailable: false,
      availableModels: [],
      availableReasoningEfforts: []
    },
    openclawGateway: null,
    availableCommands: [],
    availableSkills: [],
    ...overrides
  } as AgentGUINodeViewModel;
}
