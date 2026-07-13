import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentGUI, type AgentGUIProps } from "./AgentGUI";

function createAgentGUIProps(locale: AgentGUIProps["locale"]): AgentGUIProps {
  return {
    locale,
    frame: { previewMode: false }
  } as AgentGUIProps;
}

vi.mock("./agent-gui/agentGuiNode/AgentGUINode", async () => {
  const { useTranslation } =
    await vi.importActual<typeof import("./i18n/index")>("./i18n/index");
  const { useOptionalAgentActivityRuntime } = await vi.importActual<
    typeof import("./agentActivityRuntime")
  >("./agentActivityRuntime");
  const { Tooltip, TooltipContent, TooltipTrigger } = await vi.importActual<
    typeof import("@tutti-os/ui-system")
  >("@tutti-os/ui-system");

  return {
    AgentGUINode: () => {
      const { t } = useTranslation();
      const activityRuntime = useOptionalAgentActivityRuntime();
      return (
        <>
          <div data-testid="agent-gui-language-probe">
            {t("agentHost.agentGui.newConversation")}
          </div>
          <div data-testid="agent-gui-runtime-probe">
            {activityRuntime ? "provided" : "missing"}
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
});
