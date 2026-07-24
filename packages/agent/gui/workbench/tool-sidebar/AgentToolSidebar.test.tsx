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

  it("collapses for a container constraint without resizing the host window", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const ref = createRef<AgentToolSidebarHandle>();
    const resizeContainerContentWidth = vi.fn(async (width: number) => ({
      width
    }));
    render(
      <AgentToolSidebar
        ref={ref}
        containerWidth={1500}
        copy={copy}
        header={{
          layout: "overlay",
          owner: "window",
          render: (layout) => <header>{layout.actions}</header>
        }}
        mainContentMinWidthPx={750}
        panels={panels}
        renderPanel={({ tab }) => <div>{tab.panel} content</div>}
        resizeContainerContentWidth={resizeContainerContentWidth}
      >
        <main>Agent content</main>
      </AgentToolSidebar>
    );

    await act(async () => {
      ref.current?.openPanel("files");
    });
    const resizeCallCount = resizeContainerContentWidth.mock.calls.length;
    await act(async () => {
      ref.current?.collapseForContainerConstraint();
    });

    expect(screen.getByLabelText("Open right panel")).toBeInTheDocument();
    expect(resizeContainerContentWidth).toHaveBeenCalledTimes(resizeCallCount);
  });

  it("registers one host-owned header without adding window chrome or a panel header", () => {
    const { container } = render(
      <AgentToolSidebar
        containerWidth={900}
        copy={copy}
        header={{
          layout: "overlay",
          owner: "host",
          render: (layout) => (
            <div data-testid="host-header-actions">{layout.actions}</div>
          )
        }}
        panels={panels}
        renderPanel={({ tab }) => <div>{tab.panel} content</div>}
        resizeContainerContentWidth={async (width) => ({ width })}
      >
        <main>Agent content</main>
      </AgentToolSidebar>
    );

    const hostHeader = screen.getByTestId("host-header-actions");
    fireEvent.click(within(hostHeader).getByLabelText("Open right panel"));

    expect(
      within(hostHeader).getByLabelText("Close right panel")
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-agent-tool-sidebar-header-spacer="true"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector(".workbench-window__header")
    ).not.toBeInTheDocument();
    expect(
      container.querySelector(".workbench-window__body")
    ).not.toBeInTheDocument();
    expect(
      container.querySelector(
        '[data-agent-tool-sidebar="true"] [data-agent-tool-sidebar-header="true"]'
      )
    ).not.toBeInTheDocument();
  });

  it("does not reserve header space when the host stacks the body below it", () => {
    const { container } = render(
      <AgentToolSidebar
        containerWidth={900}
        copy={copy}
        header={{
          layout: "stacked",
          owner: "host",
          render: (layout) => <div>{layout.actions}</div>
        }}
        panels={panels}
        renderPanel={({ tab }) => <div>{tab.panel} content</div>}
        resizeContainerContentWidth={async (width) => ({ width })}
      >
        <main>Agent content</main>
      </AgentToolSidebar>
    );

    fireEvent.click(screen.getByLabelText("Open right panel"));

    expect(
      container.querySelector('[data-agent-tool-sidebar-header-spacer="true"]')
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

  it("lets host-owned blank header gestures bubble while controls remain interactive", () => {
    const handleParentDoubleClick = vi.fn();
    const handleParentPointerDown = vi.fn();
    const { container } = render(
      <div
        onDoubleClick={handleParentDoubleClick}
        onPointerDown={handleParentPointerDown}
      >
        <AgentToolSidebar
          containerWidth={900}
          copy={copy}
          header={{
            layout: "overlay",
            owner: "host",
            render: (layout) => <div>{layout.actions}</div>
          }}
          panels={panels}
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
      '[data-agent-tool-sidebar-header="true"]'
    );
    const tabList = container.querySelector(
      '[data-agent-tool-tab-list="true"]'
    );
    const toolbar = container.querySelector(
      '[data-agent-tool-sidebar-toolbar="true"]'
    );

    expect(header).toHaveAttribute(
      "data-agent-tool-sidebar-drag-region",
      "true"
    );
    expect(header).not.toHaveClass("nodrag");
    expect(header?.className).toContain("[-webkit-app-region:no-drag]");
    expect(header?.className).not.toContain("[-webkit-app-region:drag]");
    expect(tabList).not.toHaveClass("nodrag");
    expect(tabList?.className).not.toContain("[-webkit-app-region:drag]");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveClass("nodrag");
    expect(toolbar).toHaveClass("nodrag");

    fireEvent.pointerDown(tabList as HTMLElement);
    fireEvent.doubleClick(tabList as HTMLElement);
    expect(handleParentPointerDown).toHaveBeenCalledOnce();
    expect(handleParentDoubleClick).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole("tab", { name: "Files" }));
    fireEvent.doubleClick(screen.getByRole("tab", { name: "Files" }));
    fireEvent.pointerDown(toolbar as HTMLElement);
    fireEvent.doubleClick(toolbar as HTMLElement);

    expect(handleParentPointerDown).toHaveBeenCalledOnce();
    expect(handleParentDoubleClick).toHaveBeenCalledOnce();
  });

  it("keeps native-window header dragging for a window-owned header", () => {
    const { container } = renderSidebar();
    const header = container.querySelector(
      '[data-agent-tool-sidebar-header="true"]'
    );

    expect(header?.className).toContain("[-webkit-app-region:drag]");
    expect(header?.className).not.toContain("[-webkit-app-region:no-drag]");
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
      header={{
        layout: "overlay",
        owner: "window",
        render: (layout) => <header>{layout.actions}</header>
      }}
      panels={panels}
      renderPanel={({ tab }) => <div>{tab.panel} content</div>}
      resizeContainerContentWidth={resizeContainerContentWidth}
    >
      <main>Agent content</main>
    </AgentToolSidebar>
  );
}
