import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentGUI, type AgentGUIProps } from "./AgentGUI";

const { agentGuiNodeSpy } = vi.hoisted(() => ({
  agentGuiNodeSpy: vi.fn()
}));

interface AgentGUINodeProbeProps {
  hostCapabilities: {
    agentTargets?: readonly {
      agentTargetId?: string;
      availability: unknown;
      ref: unknown;
    }[];
    disabledHomeSuggestions?: readonly string[];
    handoffAgentTargets?: readonly {
      agentTargetId?: string;
      availability: unknown;
      ref: unknown;
    }[];
  };
}

function createAgentGUIProps(locale: AgentGUIProps["locale"]): AgentGUIProps {
  return {
    agentDirectory: {
      agents: [],
      capturedAtUnixMs: null,
      error: null,
      status: "ready"
    },
    locale,
    frame: { previewMode: false }
  } as unknown as AgentGUIProps;
}

vi.mock("./agent-gui/agentGuiNode/AgentGUINode", async () => {
  const { useTranslation } =
    await vi.importActual<typeof import("./i18n/index")>("./i18n/index");
  const { useOptionalAgentActivityRuntime } = await vi.importActual<
    typeof import("./agentActivityRuntime")
  >("./agentActivityRuntime");
  const { useOptionalTuttiModePlanReviewRuntime } = await vi.importActual<
    typeof import("./workspaceWorkflow")
  >("./workspaceWorkflow");
  const { Tooltip, TooltipContent, TooltipTrigger } = await vi.importActual<
    typeof import("@tutti-os/ui-system")
  >("@tutti-os/ui-system");

  return {
    AgentGUINode: (props: AgentGUINodeProbeProps) => {
      agentGuiNodeSpy(props);
      const { t } = useTranslation();
      const activityRuntime = useOptionalAgentActivityRuntime();
      const workflowRuntime = useOptionalTuttiModePlanReviewRuntime();
      return (
        <>
          <div data-testid="agent-gui-language-probe">
            {t("agentHost.agentGui.newConversation")}
          </div>
          <div data-testid="agent-gui-runtime-probe">
            {activityRuntime ? "provided" : "missing"}
          </div>
          <div data-testid="workspace-workflow-runtime-probe">
            {workflowRuntime ? "provided" : "missing"}
          </div>
          <div data-testid="agent-gui-disabled-suggestions-probe">
            {JSON.stringify(
              props.hostCapabilities.disabledHomeSuggestions ?? []
            )}
          </div>
          <div data-testid="agent-gui-directory-targets-probe">
            {JSON.stringify(
              props.hostCapabilities.agentTargets?.map(
                (target) => target.agentTargetId
              ) ?? []
            )}
          </div>
          <div data-testid="agent-gui-handoff-targets-probe">
            {JSON.stringify(
              props.hostCapabilities.handoffAgentTargets?.map(
                (target) => target.agentTargetId
              ) ?? []
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button">tooltip probe</button>
            </TooltipTrigger>
            <TooltipContent>AgentGUI tooltip probe</TooltipContent>
          </Tooltip>
        </>
      );
    }
  };
});

describe("AgentGUI i18n", () => {
  beforeEach(() => {
    agentGuiNodeSpy.mockClear();
  });

  it("rerenders agent copy when the host locale changes", () => {
    const { rerender } = render(<AgentGUI {...createAgentGUIProps("en")} />);

    expect(screen.getByTestId("agent-gui-language-probe")).toHaveTextContent(
      "New session"
    );

    rerender(<AgentGUI {...createAgentGUIProps("zh-CN")} />);

    expect(screen.getByTestId("agent-gui-language-probe")).toHaveTextContent(
      "新建会话"
    );
  });

  it("uses the host locale when mounted", () => {
    render(<AgentGUI {...createAgentGUIProps("zh-CN")} />);

    expect(screen.getByTestId("agent-gui-language-probe")).toHaveTextContent(
      "新建会话"
    );
  });

  it("provides the required activity runtime to the AgentGUI node", () => {
    render(
      <AgentGUI
        {...createAgentGUIProps("en")}
        agentActivityRuntime={{} as AgentGUIProps["agentActivityRuntime"]}
      />
    );

    expect(screen.getByTestId("agent-gui-runtime-probe")).toHaveTextContent(
      "provided"
    );
  });

  it("provides the optional workspace workflow runtime to the AgentGUI node", () => {
    render(
      <AgentGUI
        {...createAgentGUIProps("en")}
        tuttiModePlanReviewRuntime={
          {} as AgentGUIProps["tuttiModePlanReviewRuntime"]
        }
      />
    );

    expect(
      screen.getByTestId("workspace-workflow-runtime-probe")
    ).toHaveTextContent("provided");
  });

  it("forwards disabled home suggestions to the internal node", () => {
    render(
      <AgentGUI
        {...createAgentGUIProps("en")}
        disabled={["meet-tutti", "import-session"]}
      />
    );

    expect(
      screen.getByTestId("agent-gui-disabled-suggestions-probe")
    ).toHaveTextContent('["meet-tutti","import-session"]');
  });

  it("keeps the runtime directory separate from the handoff launch directory", () => {
    render(
      <AgentGUI
        {...createAgentGUIProps("en")}
        agentDirectory={{
          agents: [agent("local-codex", "codex")],
          capturedAtUnixMs: null,
          error: null,
          status: "ready"
        }}
        handoffAgentDirectory={{
          agents: [
            agent("local-codex", "codex"),
            agent("shared-agent:claude", "claude-code")
          ],
          capturedAtUnixMs: null,
          error: null,
          status: "ready"
        }}
      />
    );

    expect(
      screen.getByTestId("agent-gui-directory-targets-probe")
    ).toHaveTextContent('["local-codex"]');
    expect(
      screen.getByTestId("agent-gui-handoff-targets-probe")
    ).toHaveTextContent('["local-codex","shared-agent:claude"]');
  });

  it("reuses agent target projections across frame-only renders", () => {
    const agents = [agent("local-codex", "codex")];
    const props = {
      ...createAgentGUIProps("en"),
      agentDirectory: {
        agents,
        capturedAtUnixMs: null,
        error: null,
        status: "ready" as const
      }
    };
    const { rerender } = render(<AgentGUI {...props} />);
    const first = agentGuiNodeSpy.mock.calls.at(-1)?.[0] as
      | AgentGUINodeProbeProps
      | undefined;

    rerender(
      <AgentGUI
        {...props}
        frame={{ ...props.frame, width: 960, height: 640 }}
      />
    );
    const second = agentGuiNodeSpy.mock.calls.at(-1)?.[0] as
      | AgentGUINodeProbeProps
      | undefined;

    expect(second?.hostCapabilities.agentTargets).toBe(
      first?.hostCapabilities.agentTargets
    );
    expect(second?.hostCapabilities.handoffAgentTargets).toBe(
      first?.hostCapabilities.handoffAgentTargets
    );
    expect(second?.hostCapabilities.handoffAgentTargets).toBe(
      second?.hostCapabilities.agentTargets
    );
    expect(second?.hostCapabilities.agentTargets?.[0]?.availability).toBe(
      first?.hostCapabilities.agentTargets?.[0]?.availability
    );
    expect(second?.hostCapabilities.agentTargets?.[0]?.ref).toBe(
      first?.hostCapabilities.agentTargets?.[0]?.ref
    );
  });

  it("rebuilds agent target projections when the directory changes", () => {
    const firstAgent = agent("local-codex", "codex");
    const props = {
      ...createAgentGUIProps("en"),
      agentDirectory: {
        agents: [firstAgent],
        capturedAtUnixMs: null,
        error: null,
        status: "ready" as const
      }
    };
    const { rerender } = render(<AgentGUI {...props} />);
    const first = agentGuiNodeSpy.mock.calls.at(-1)?.[0] as
      | AgentGUINodeProbeProps
      | undefined;

    rerender(
      <AgentGUI
        {...props}
        agentDirectory={{
          ...props.agentDirectory,
          agents: [
            {
              ...firstAgent,
              availability: { status: "auth_required" as const }
            }
          ]
        }}
      />
    );
    const second = agentGuiNodeSpy.mock.calls.at(-1)?.[0] as
      | AgentGUINodeProbeProps
      | undefined;

    expect(second?.hostCapabilities.agentTargets).not.toBe(
      first?.hostCapabilities.agentTargets
    );
    expect(second?.hostCapabilities.agentTargets?.[0]?.availability).not.toBe(
      first?.hostCapabilities.agentTargets?.[0]?.availability
    );
    expect(second?.hostCapabilities.agentTargets?.[0]?.ref).not.toBe(
      first?.hostCapabilities.agentTargets?.[0]?.ref
    );
  });
});

function agent(agentTargetId: string, provider: string) {
  return {
    agentTargetId,
    name: agentTargetId,
    iconUrl: `/${agentTargetId}.png`,
    availability: { status: "ready" as const },
    provider
  };
}
