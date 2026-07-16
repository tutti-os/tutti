import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentGUI, type AgentGUIProps } from "./AgentGUI";

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
    AgentGUINode: (props: {
      hostCapabilities: { disabledHomeSuggestions?: readonly string[] };
    }) => {
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
});
