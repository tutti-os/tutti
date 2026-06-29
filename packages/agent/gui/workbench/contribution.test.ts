import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement, isValidElement, type ReactElement } from "react";
import { agentGuiDockIconUrls } from "../dockIcons.ts";
import {
  AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
  agentGuiWorkbenchDefaultCopy,
  createAgentGuiWorkbenchContribution,
  resolveAgentGuiWorkbenchDefaultLaunchFrame,
  resolveAgentGuiWorkbenchContributionCopy
} from "./contribution.ts";
import {
  agentGuiWorkbenchDockEntryId,
  agentGuiWorkbenchTypeId
} from "./launch.ts";

function readDockEntryIconSrc(icon: unknown): string | undefined {
  if (!isValidElement(icon)) {
    return undefined;
  }
  return (icon as ReactElement<{ src?: string }>).props.src;
}

function createTestAgentGuiWorkbenchContribution(
  input: Omit<
    Parameters<typeof createAgentGuiWorkbenchContribution>[0],
    "renderMinimizedPreview"
  > &
    Partial<
      Pick<
        Parameters<typeof createAgentGuiWorkbenchContribution>[0],
        "renderMinimizedPreview"
      >
    >
) {
  return createAgentGuiWorkbenchContribution({
    renderMinimizedPreview: () => null,
    ...input
  });
}

describe("agent GUI workbench contribution copy", () => {
  it("uses package defaults when the host does not provide copy", () => {
    expect(resolveAgentGuiWorkbenchContributionCopy()).toEqual(
      agentGuiWorkbenchDefaultCopy
    );

    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    expect(contribution.nodes?.[0]?.title).toBe(
      agentGuiWorkbenchDefaultCopy.nodeTitle
    );
  });

  it("lets hosts override only the copy they own", () => {
    expect(
      resolveAgentGuiWorkbenchContributionCopy({
        nodeTitle: "Assistant"
      })
    ).toEqual({
      ...agentGuiWorkbenchDefaultCopy,
      nodeTitle: "Assistant"
    });
  });

  it("uses packaged dock icons when the host does not provide icon URLs", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    const codexDockEntry = contribution.dockEntries?.find(
      (entry) => entry.id === agentGuiWorkbenchDockEntryId("codex")
    );

    expect(readDockEntryIconSrc(codexDockEntry?.icon)).toBe(
      agentGuiDockIconUrls.codex
    );
  });

  it("lets hosts override packaged dock icons explicitly", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      dockIconUrls: {
        codex: "app://icons/codex.png"
      },
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    const codexDockEntry = contribution.dockEntries?.find(
      (entry) => entry.id === agentGuiWorkbenchDockEntryId("codex")
    );
    const geminiDockEntry = contribution.dockEntries?.find(
      (entry) => entry.id === agentGuiWorkbenchDockEntryId("gemini")
    );

    expect(readDockEntryIconSrc(codexDockEntry?.icon)).toBe(
      "app://icons/codex.png"
    );
    expect(readDockEntryIconSrc(geminiDockEntry?.icon)).toBe(
      agentGuiDockIconUrls.gemini
    );
  });

  it("uses browser-loadable packaged icons in the workbench header", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      dockIconUrls: {
        codex: "tutti-asset://agent/codex.png"
      },
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    render(
      contribution.nodes?.[0]?.renderHeader?.({
        activation: null,
        defaultActions: null,
        displayMode: "floating",
        dragHandleProps: {},
        externalNodeState: null,
        externalWorkspaceState: null,
        instanceId: "agent-gui:codex:panel:test-1",
        instanceKey: null,
        isFocused: true,
        node: {
          data: {
            runtimeNodeState: null
          },
          displayMode: "floating",
          frame: { height: 560, width: 1040, x: 0, y: 0 },
          id: "agent-gui-node-1",
          title: "Codex"
        },
        surfaceSize: { height: 800, width: 1200 },
        windowActions: {
          applyQuickLayout: () => {},
          close: () => {},
          focus: () => {},
          minimize: () => {},
          resize: () => {},
          toggleDisplayMode: () => {}
        }
      } as never) ?? null
    );

    const headerIcon = screen.getByText("Codex")
      .previousElementSibling as HTMLImageElement | null;
    expect(headerIcon).toHaveAttribute("src", agentGuiDockIconUrls.codex);
    expect(headerIcon).not.toHaveAttribute(
      "src",
      "tutti-asset://agent/codex.png"
    );
  });

  it("opens at the default width and 70 percent height when the workbench area can fit the default frame", () => {
    const frame = resolveAgentGuiWorkbenchDefaultLaunchFrame({
      frame: { height: 560, width: 1040, x: 140, y: 48 },
      request: {
        layoutConstraints: {
          minHeight: 160,
          minWidth: 280,
          safeArea: {
            bottom: 79,
            left: 0,
            right: 0,
            top: 52
          },
          surfacePadding: 0
        },
        surfaceSize: {
          height: 900,
          width: 1440
        }
      }
    });

    expect(frame).toEqual({
      height: 538,
      width: 1040,
      x: 140,
      y: 48
    });
  });

  it("opens at 90 percent of the visible workbench area when the window cannot fit the default frame", () => {
    const frame = resolveAgentGuiWorkbenchDefaultLaunchFrame({
      frame: { height: 560, width: 1040, x: 140, y: 48 },
      request: {
        layoutConstraints: {
          minHeight: 160,
          minWidth: 280,
          safeArea: {
            bottom: 79,
            left: 0,
            right: 0,
            top: 52
          },
          surfacePadding: 0
        },
        surfaceSize: {
          height: 700,
          width: 980
        }
      }
    });

    expect(frame).toEqual({
      height: 512,
      width: 882,
      x: 49,
      y: 81
    });
  });

  it("uses 90 percent of the visible height when the remaining workbench height is compact", () => {
    const frame = resolveAgentGuiWorkbenchDefaultLaunchFrame({
      frame: { height: 560, width: 1040, x: 140, y: 48 },
      request: {
        layoutConstraints: {
          minHeight: 160,
          minWidth: 280,
          safeArea: {
            bottom: 79,
            left: 0,
            right: 0,
            top: 52
          },
          surfacePadding: 0
        },
        surfaceSize: {
          height: 747,
          width: 1440
        }
      }
    });

    expect(frame).toEqual({
      height: 554,
      width: 1040,
      x: 200,
      y: 83
    });
  });

  it("preserves the 90 percent visible-area frame during compact launches", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    const launchResult = contribution.onLaunchRequest?.({
      layoutConstraints: {
        minHeight: 160,
        minWidth: 280,
        safeArea: {
          bottom: 79,
          left: 0,
          right: 0,
          top: 52
        },
        surfacePadding: 0
      },
      payload: null,
      reason: "dock",
      surfaceSize: {
        height: 700,
        width: 980
      },
      typeId: "agent-gui",
      workspaceId: "workspace-1"
    });

    expect(launchResult).toMatchObject({
      defaultFrame: {
        height: 512,
        width: 882,
        x: 49,
        y: 81
      },
      framePolicy: "absolute"
    });
  });

  it("matches codex panel nodes and only renders popup previews through the host renderer", async () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const dockEntry = contribution.dockEntries?.find(
      (entry) => entry.id === agentGuiWorkbenchTypeId
    );
    expect(dockEntry).toBeDefined();

    const node = {
      data: {
        dockEntryId: agentGuiWorkbenchTypeId,
        instanceId: "agent-gui:codex:panel:test-1",
        typeId: agentGuiWorkbenchTypeId
      },
      id: "agent-gui:agent-gui:codex:panel:test-1",
      title: "Codex"
    };

    expect(dockEntry?.matchNode?.(node as never)).toBe(true);
    expect(
      dockEntry?.providePopupItemPreview?.({
        externalNodeState: {
          lastActiveAgentSessionId: "session-1",
          lastActiveConversationTitle: "Implement dock previews"
        },
        externalWorkspaceState: null,
        host: {} as never,
        isFocused: false,
        isMinimized: false,
        node: node as never
      }) ?? null
    ).toBeNull();
  });

  it("uses the host preview renderer for agent GUI dock popup previews", async () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      renderPreview: () => "preview",
      resolveDockPopupTitle: (state) =>
        state?.lastActiveAgentSessionId === "session-1"
          ? "Current session title"
          : null,
      workspaceId: "workspace-1"
    });
    const dockEntry = contribution.dockEntries?.find(
      (entry) => entry.id === agentGuiWorkbenchTypeId
    );
    expect(dockEntry).toBeDefined();

    const node = {
      data: {
        dockEntryId: agentGuiWorkbenchTypeId,
        instanceId: "agent-gui:codex:panel:test-1",
        typeId: agentGuiWorkbenchTypeId
      },
      displayMode: "floating",
      frame: { height: 560, width: 1040, x: 0, y: 0 },
      id: "agent-gui:agent-gui:codex:panel:test-1",
      isMinimized: false,
      restoreFrame: null,
      title: "Codex"
    };

    const preview =
      dockEntry?.providePopupItemPreview?.({
        externalNodeState: {
          lastActiveAgentSessionId: "session-1",
          lastActiveConversationTitle: "Stale session title"
        },
        externalWorkspaceState: null,
        host: {} as never,
        isFocused: false,
        isMinimized: false,
        node: node as never
      }) ?? null;
    expect(preview?.kind).toBe("component");
    expect(preview?.revision).toContain("Current session title");
    expect(preview?.revision).not.toContain("Stale session title");
  });

  it("uses the host minimized preview renderer for agent GUI minimized slots", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      renderMinimizedPreview: () => "minimized-preview",
      resolveDockPopupTitle: (state) =>
        state?.lastActiveAgentSessionId === "session-1"
          ? "Current session title"
          : null,
      workspaceId: "workspace-1"
    });
    const minimizedDock = contribution.nodes?.[0]?.window?.minimizedDock;
    expect(minimizedDock?.kind).toBe("component");
    if (minimizedDock?.kind !== "component") {
      throw new Error("expected component minimized preview");
    }

    const preview =
      minimizedDock.providePreview({
        externalNodeState: {
          lastActiveAgentSessionId: "session-1",
          lastActiveConversationTitle: "Stale session title"
        },
        externalWorkspaceState: null,
        host: {} as never,
        isFocused: false,
        isMinimized: true,
        node: {
          data: {
            dockEntryId: agentGuiWorkbenchTypeId,
            instanceId: "agent-gui:codex:panel:test-1",
            typeId: agentGuiWorkbenchTypeId
          },
          displayMode: "floating",
          frame: { height: 560, width: 1040, x: 0, y: 0 },
          id: "agent-gui:agent-gui:codex:panel:test-1",
          isMinimized: true,
          restoreFrame: null,
          title: "Codex"
        } as never
      }) ?? null;

    expect(preview?.kind).toBe("component");
    if (preview?.kind !== "component") {
      throw new Error("expected component preview content");
    }
    expect(preview.element).toBe("minimized-preview");
    expect(preview.revision).toContain("Current session title");
    expect(preview.revision).not.toContain("Stale session title");
  });

  it("shows a new-session action when collapsed", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const events: CustomEvent[] = [];
    const handler = (event: Event) => {
      events.push(event as CustomEvent);
    };
    window.addEventListener(
      AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
      handler
    );

    try {
      render(
        contribution.nodes?.[0]?.renderHeader?.({
          activation: null,
          defaultActions: null,
          displayMode: "floating",
          dragHandleProps: {},
          externalNodeState: {
            conversationRailCollapsed: true,
            lastActiveAgentSessionId: null
          },
          externalWorkspaceState: null,
          instanceId: "agent-gui:codex:panel:test-1",
          instanceKey: null,
          isFocused: true,
          node: {
            data: {
              runtimeNodeState: null
            },
            displayMode: "floating",
            frame: { height: 560, width: 1040, x: 0, y: 0 },
            id: "agent-gui-node-1",
            title: "Codex"
          },
          surfaceSize: { height: 800, width: 1200 },
          windowActions: {
            applyQuickLayout: () => {},
            close: () => {},
            focus: () => {},
            minimize: () => {},
            resize: () => {},
            toggleDisplayMode: () => {}
          }
        } as never) ?? null
      );

      fireEvent.click(
        screen.getByRole("button", {
          name: agentGuiWorkbenchDefaultCopy.newConversation
        })
      );
    } finally {
      window.removeEventListener(
        AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
        handler
      );
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({
      instanceId: "agent-gui:codex:panel:test-1"
    });
  });

  it("keeps the app title separate from the active session title when collapsed", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      resolveDockPopupTitle: (state) =>
        state?.lastActiveAgentSessionId === "session-1"
          ? "Current session title"
          : null,
      workspaceId: "workspace-1"
    });

    const close = vi.fn();
    const minimize = vi.fn();
    const toggleDisplayMode = vi.fn();

    render(
      contribution.nodes?.[0]?.renderHeader?.({
        activation: null,
        defaultActions: null,
        displayMode: "floating",
        dragHandleProps: {},
        externalNodeState: {
          conversationRailCollapsed: true,
          lastActiveAgentSessionId: "session-1"
        },
        externalWorkspaceState: null,
        instanceId: "agent-gui:codex:panel:test-1",
        instanceKey: null,
        isFocused: true,
        node: {
          data: {
            runtimeNodeState: null
          },
          displayMode: "floating",
          frame: { height: 560, width: 1040, x: 0, y: 0 },
          id: "agent-gui-node-1",
          title: "Codex"
        },
        surfaceSize: { height: 800, width: 1200 },
        windowActions: {
          applyQuickLayout: () => {},
          close,
          focus: () => {},
          minimize,
          resize: () => {},
          toggleDisplayMode
        }
      } as never) ?? null
    );

    const newConversationButton = screen.getByRole("button", {
      name: agentGuiWorkbenchDefaultCopy.newConversation
    });
    const toggleButton = screen.getByTestId(
      "agent-gui-toggle-conversation-rail"
    );
    const header = document.querySelector(
      '[data-agent-gui-workbench-header="true"]'
    );
    const primary = document.querySelector(
      "[data-agent-gui-workbench-header-primary='true']"
    );

    expect(header).toHaveAttribute(
      "data-agent-gui-workbench-header-collapsed",
      "true"
    );
    expect(primary).toContainElement(screen.getByText("Codex"));
    expect(screen.getByTestId("agent-gui-window-title-icon")).toHaveAttribute(
      "src",
      agentGuiDockIconUrls.codex
    );
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(toggleButton).toHaveClass("agent-gui-workbench-header__icon-button");
    expect(toggleButton).toHaveClass("agent-gui-workbench-header__rail-toggle");
    expect(toggleButton).toHaveAttribute("data-size", "icon-sm");
    expect(toggleButton.querySelector("svg")).toHaveClass(
      "agent-gui-workbench-header__icon"
    );
    expect(newConversationButton).toHaveClass(
      "agent-gui-workbench-header__icon-button"
    );
    expect(newConversationButton).toHaveAttribute("data-size", "icon-sm");
    expect(newConversationButton.querySelector("svg")).toHaveClass(
      "agent-gui-workbench-header__icon"
    );
    const collapsedSessionTitle = screen
      .getByText("Current session title")
      .closest(".agent-gui-workbench-header__session-title");
    expect(collapsedSessionTitle).not.toBeNull();
    expect(screen.getByText("Current session title")).toHaveClass(
      "agent-gui-workbench-header__title-text"
    );
    expect(screen.queryByTestId("agent-gui-window-detail-title")).toBeNull();

    fireEvent.click(screen.getByTestId("agent-gui-window-close"));
    fireEvent.click(screen.getByTestId("agent-gui-window-minimize"));
    fireEvent.click(screen.getByTestId("agent-gui-window-toggle-display-mode"));

    expect(close).toHaveBeenCalledTimes(1);
    expect(minimize).toHaveBeenCalledTimes(1);
    expect(toggleDisplayMode).toHaveBeenCalledTimes(1);
  });

  it("renders the expanded workbench header as a rail titlebar plus detail title", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      resolveDockPopupTitle: (state) =>
        state?.lastActiveAgentSessionId === "session-1"
          ? "Current session title"
          : null,
      workspaceId: "workspace-1"
    });

    render(
      contribution.nodes?.[0]?.renderHeader?.({
        activation: null,
        defaultActions: createElement(
          "button",
          { type: "button" },
          "window actions"
        ),
        displayMode: "floating",
        dragHandleProps: {},
        externalNodeState: {
          conversationRailCollapsed: false,
          conversationRailWidthPx: 360,
          lastActiveAgentSessionId: "session-1"
        },
        externalWorkspaceState: null,
        instanceId: "agent-gui:codex:panel:test-1",
        instanceKey: null,
        isFocused: true,
        node: {
          data: {
            runtimeNodeState: null
          },
          displayMode: "floating",
          frame: { height: 560, width: 1040, x: 0, y: 0 },
          id: "agent-gui-node-1",
          title: "Codex"
        },
        surfaceSize: { height: 800, width: 1200 },
        windowActions: {
          applyQuickLayout: () => {},
          close: () => {},
          focus: () => {},
          minimize: () => {},
          resize: () => {},
          toggleDisplayMode: () => {}
        }
      } as never) ?? null
    );

    const header = document.querySelector(
      '[data-agent-gui-workbench-header="true"]'
    );
    const primary = document.querySelector(
      "[data-agent-gui-workbench-header-primary='true']"
    );

    expect(header).toHaveClass("agent-gui-workbench-header");
    expect(header).toHaveAttribute(
      "data-agent-gui-workbench-header-collapsed",
      "false"
    );
    expect(header).toHaveStyle({
      "--agent-gui-workbench-header-rail-width": "360px"
    });
    expect(primary).toHaveClass("agent-gui-workbench-header__primary");
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-gui-toggle-conversation-rail")
    ).toHaveClass("agent-gui-workbench-header__rail-toggle");
    const headerIcon = screen.getByTestId("agent-gui-window-title-icon");
    expect(headerIcon).toHaveAttribute("src", agentGuiDockIconUrls.codex);
    expect(headerIcon).toHaveAttribute(
      "data-agent-gui-workbench-header-icon",
      "true"
    );
    expect(
      screen.getByTestId("agent-gui-window-detail-title")
    ).toHaveTextContent("Current session title");
    expect(
      screen.queryByRole("button", { name: "window actions" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: agentGuiWorkbenchDefaultCopy.newConversation
      })
    ).not.toBeInTheDocument();
  });

  it("caps workbench header conversation titles at 280px", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /--agent-gui-workbench-header-title-max-width:\s*280px;/
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__session-title\s*{[^}]*max-width:\s*min\(100%,\s*var\(--agent-gui-workbench-header-title-max-width\)\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__detail-title\s*{[^}]*max-width:\s*min\(100%,\s*var\(--agent-gui-workbench-header-title-max-width\)\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__title-text\s*{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s
    );
  });

  it("keeps the traffic light group aligned with the agent identity", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(/--agent-gui-workbench-header-padding-x:\s*16px;/);
    expect(css).toMatch(
      /--agent-gui-workbench-header-agent-icon-size:\s*20px;/
    );
    expect(css).toMatch(/--agent-gui-workbench-header-primary-gap:\s*12px;/);
    expect(css).toMatch(
      /--agent-gui-workbench-header-traffic-light-size:\s*12px;/
    );
    expect(css).toMatch(
      /--agent-gui-workbench-header-traffic-light-gap:\s*8px;/
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__primary\s*{[^}]*padding:\s*0\s+var\(--agent-gui-workbench-header-padding-x\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__primary\s*{[^}]*gap:\s*var\(--agent-gui-workbench-header-primary-gap\);/s
    );
    const headerPrimaryCss = css.match(
      /\.agent-gui-workbench-header__primary\s*{(?<body>[^}]*)}/s
    )?.groups?.body;
    expect(headerPrimaryCss).toBeDefined();
    expect(headerPrimaryCss).not.toMatch(/border-right:/);
    expect(css).toMatch(
      /\.agent-gui-node__rail-panel\s*{[^}]*border-right:\s*0;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__traffic-lights\s*{[^}]*margin-right:\s*0;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__traffic-light\s*{[^}]*width:\s*var\(--agent-gui-workbench-header-traffic-light-size\);[^}]*height:\s*var\(--agent-gui-workbench-header-traffic-light-size\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__agent-brand\s*{[^}]*gap:\s*8px;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__agent-icon\s*{[^}]*width:\s*var\(--agent-gui-workbench-header-agent-icon-size\);[^}]*height:\s*var\(--agent-gui-workbench-header-agent-icon-size\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__rail-toggle\s*{[^}]*margin-left:\s*auto;/s
    );
    const agentIconCss = css.match(
      /\.agent-gui-workbench-header__agent-icon\s*{(?<body>[^}]*)}/s
    )?.groups?.body;
    expect(agentIconCss).toBeDefined();
    expect(agentIconCss).not.toMatch(/box-shadow:/);
  });
});
