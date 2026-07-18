import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentToolSidebar,
  type AgentToolSidebarHandle
} from "./AgentToolSidebar.tsx";
import type { AgentToolSidebarCopy } from "./Toolbar.tsx";

const panels = [
  { id: "files", label: "Files" },
  { id: "terminal", label: "Terminal" },
  { id: "browser", label: "Browser" }
] as const;

const copy: AgentToolSidebarCopy = {
  close: "Close",
  closeRightPanel: "Close right panel",
  expand: "Expand",
  newTab: "New tab",
  openRightPanel: "Open right panel",
  resizeSidebar: "Resize sidebar",
  shrink: "Shrink",
  tool: "Tools"
};

describe("AgentToolSidebar", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders only the host-provided panel choices", async () => {
    renderSidebar();

    fireEvent.click(screen.getByLabelText("Open right panel"));

    expect(await screen.findByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Terminal")).toBeInTheDocument();
    expect(screen.getByText("Browser")).toBeInTheDocument();
    expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
    expect(screen.queryByText("Apps")).not.toBeInTheDocument();
    expect(screen.queryByText("Messages")).not.toBeInTheDocument();
  });

  it("opens a panel through the shared handle and keeps its content mounted", async () => {
    vi.useFakeTimers();
    const ref = createRef<AgentToolSidebarHandle>();
    renderSidebar(ref);

    await act(async () => {
      ref.current?.openPanel("terminal");
    });
    await act(async () => {
      vi.runAllTimers();
    });

    expect(screen.getByText("terminal content")).toBeVisible();

    await act(async () => {
      ref.current?.openPanel("files");
    });
    await act(async () => {
      vi.runAllTimers();
    });

    expect(screen.getByText("files content")).toBeVisible();
    expect(
      screen.getByText("terminal content").closest("[aria-hidden]")
    ).toHaveAttribute("aria-hidden", "true");
  });

  it("restores the host width when the sidebar closes", async () => {
    const resizeContainerContentWidth = vi.fn(async (width: number) => ({
      width
    }));
    const ref = createRef<AgentToolSidebarHandle>();
    renderSidebar(ref, resizeContainerContentWidth);

    await act(async () => {
      ref.current?.openPanel("files");
    });
    await act(async () => {
      ref.current?.close();
    });

    expect(resizeContainerContentWidth).toHaveBeenLastCalledWith(
      900,
      undefined
    );
  });

  it("registers actions externally without reserving an inline header spacer", () => {
    const { container } = render(
      <AgentToolSidebar
        containerWidth={900}
        copy={copy}
        headerPlacement="external"
        panels={panels}
        renderHeader={(actions) => (
          <div data-testid="external-header-actions">{actions}</div>
        )}
        renderPanel={({ tab }) => <div>{tab.panel} content</div>}
        resizeContainerContentWidth={async (width) => ({ width })}
      >
        <main>Agent content</main>
      </AgentToolSidebar>
    );

    expect(screen.getByTestId("external-header-actions")).toBeInTheDocument();
    expect(
      container.querySelector(
        '[data-standalone-agent-tool-sidebar-header-spacer="true"]'
      )
    ).not.toBeInTheDocument();
    expect(
      container.querySelector(".workbench-window__header")
    ).not.toBeInTheDocument();
    expect(
      container.querySelector(".workbench-window__body")
    ).not.toBeInTheDocument();
  });

  it("reserves collapsed tool actions in the inline window header", () => {
    const { container } = renderSidebar();
    const header = container.querySelector<HTMLElement>(
      ".workbench-window__header"
    );

    expect(
      header?.style.getPropertyValue("--agent-gui-tool-sidebar-layout-width")
    ).toBe("132px");
  });

  it("moves the open sidebar header and collapse action into the panel", async () => {
    const { container } = render(
      <AgentToolSidebar
        containerWidth={900}
        copy={copy}
        headerPlacement="panel"
        panels={panels}
        renderHeader={(actions) => (
          <div data-testid="host-header-actions">{actions}</div>
        )}
        renderPanel={({ tab }) => <div>{tab.panel} content</div>}
        resizeContainerContentWidth={async (width) => ({ width })}
      >
        <main>Agent content</main>
      </AgentToolSidebar>
    );

    const hostHeader = screen.getByTestId("host-header-actions");
    fireEvent.click(within(hostHeader).getByLabelText("Open right panel"));

    const sidebar = container.querySelector(
      '[data-standalone-agent-tool-sidebar="true"]'
    );
    expect(sidebar).not.toBeNull();
    expect(
      within(hostHeader).queryByLabelText("Close right panel")
    ).not.toBeInTheDocument();
    expect(
      within(sidebar as HTMLElement).getByLabelText("Close right panel")
    ).toBeInTheDocument();
    expect(
      sidebar?.querySelector(
        '[data-standalone-agent-tool-sidebar-header="true"]'
      )
    ).toBeInTheDocument();

    fireEvent.click(
      within(sidebar as HTMLElement).getByLabelText("Close right panel")
    );

    expect(
      within(hostHeader).getByLabelText("Open right panel")
    ).toBeInTheDocument();
  });

  it("keeps blank panel-header space draggable while controls remain interactive", () => {
    const handlePointerDown = vi.fn();
    const { container } = render(
      <div onPointerDown={handlePointerDown}>
        <AgentToolSidebar
          containerWidth={900}
          copy={copy}
          headerPlacement="panel"
          panels={panels}
          renderHeader={(actions) => <div>{actions}</div>}
          renderPanel={({ tab }) => <div>{tab.panel} content</div>}
          resizeContainerContentWidth={async (width) => ({ width })}
        >
          <main>Agent content</main>
        </AgentToolSidebar>
      </div>
    );

    fireEvent.click(screen.getByLabelText("Open right panel"));
    fireEvent.click(screen.getByText("Files"));

    const header = container.querySelector(
      '[data-standalone-agent-tool-sidebar-header="true"]'
    );
    const tabList = container.querySelector(
      '[data-standalone-agent-tool-tab-list="true"]'
    );
    const toolbar = container.querySelector(
      '[data-standalone-agent-tool-sidebar-toolbar="true"]'
    );

    expect(header).toHaveAttribute(
      "data-standalone-agent-tool-sidebar-drag-region",
      "true"
    );
    expect(header).not.toHaveClass("nodrag");
    expect(header?.className).toContain("[-webkit-app-region:drag]");
    expect(tabList).not.toHaveClass("nodrag");
    expect(tabList?.className).toContain("[-webkit-app-region:drag]");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveClass("nodrag");
    expect(toolbar).toHaveClass("nodrag");

    handlePointerDown.mockClear();
    fireEvent.pointerDown(tabList as HTMLElement);
    expect(handlePointerDown).toHaveBeenCalledOnce();
  });
});

function renderSidebar(
  ref = createRef<AgentToolSidebarHandle>(),
  resizeContainerContentWidth = vi.fn(async (width: number) => ({ width }))
) {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  return render(
    <AgentToolSidebar
      ref={ref}
      containerWidth={900}
      copy={copy}
      panels={panels}
      renderHeader={(actions) => <header>{actions}</header>}
      renderPanel={({ tab }) => <div>{tab.panel} content</div>}
      resizeContainerContentWidth={resizeContainerContentWidth}
    >
      <main>Agent content</main>
    </AgentToolSidebar>
  );
}
