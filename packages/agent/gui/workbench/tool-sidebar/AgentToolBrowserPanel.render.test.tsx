import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserNodeHostApi } from "@tutti-os/browser-node";
import type { BrowserNodeWorkbenchHeaderProps } from "@tutti-os/browser-node/react";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  AgentToolBrowserPanel,
  type AgentToolBrowserController
} from "./AgentToolBrowserPanel.tsx";

const browserNodeMocks = vi.hoisted(() => ({
  headerProps: null as BrowserNodeWorkbenchHeaderProps | null
}));

vi.mock("@tutti-os/browser-node/react", () => ({
  BrowserNode: () => <div data-browser-node-body="true" />,
  BrowserNodeWorkbenchHeader: (props: BrowserNodeWorkbenchHeaderProps) => {
    browserNodeMocks.headerProps = props;
    return (
      <div data-browser-node-header="true" {...props.dragHandleProps}>
        <div data-testid="browser-default-actions">{props.defaultActions}</div>
        <div data-testid="browser-navigation-actions">
          {props.navigationActions}
        </div>
      </div>
    );
  }
}));

describe("AgentToolBrowserPanel header composition", () => {
  afterEach(() => {
    browserNodeMocks.headerProps = null;
  });

  it("composes host window actions into the browser tab header", async () => {
    render(
      <AgentToolBrowserPanel
        browserApi={createBrowserApi()}
        defaultActions={<button type="button">Window actions</button>}
        dragHandleProps={{ "aria-label": "Browser drag handle" }}
        hidden={false}
        i18n={{ t: (key) => key } as I18nRuntime<string>}
        navigationActions={<button type="button">Navigation action</button>}
      />
    );

    await vi.dynamicImportSettled();
    expect(
      await screen.findByLabelText("Browser drag handle")
    ).toBeInTheDocument();
    expect(screen.getByText("Window actions")).toBeInTheDocument();
    expect(screen.getByText("Navigation action")).toBeInTheDocument();
    expect(browserNodeMocks.headerProps?.defaultActions).not.toBeNull();
    expect(
      document.querySelectorAll('[data-browser-node-header="true"]')
    ).toHaveLength(1);
  });

  it("activates an existing page by URL through the host controller", async () => {
    let controller: AgentToolBrowserController | null = null;
    render(
      <AgentToolBrowserPanel
        browserApi={createBrowserApi()}
        defaultUrl="https://first.test"
        dragHandleProps={{ "aria-label": "Browser drag handle" }}
        hidden={false}
        i18n={{ t: (key) => key } as I18nRuntime<string>}
        onControllerReady={(value) => {
          controller = value;
        }}
      />
    );

    await vi.dynamicImportSettled();
    await screen.findByLabelText("Browser drag handle");
    expect(controller).not.toBeNull();
    const secondPageNodeId = controller!.createPage("https://second.test");
    expect(controller!.selectPage(secondPageNodeId)).toBe(true);

    const firstPageNodeId = controller!.activatePageByUrl(
      "https://first.test/"
    );

    expect(firstPageNodeId).not.toBeNull();
    expect(firstPageNodeId).not.toBe(secondPageNodeId);
    expect(controller!.ownsPage(firstPageNodeId!)).toBe(true);
  });
});

function createBrowserApi(): BrowserNodeHostApi {
  return {
    activate: async () => undefined,
    close: async () => undefined,
    goBack: async () => undefined,
    goForward: async () => undefined,
    navigate: async () => undefined,
    onEvent: () => () => undefined,
    prepareSession: async () => undefined,
    registerGuest: async () => undefined,
    reload: async () => undefined,
    unregisterGuest: async () => undefined
  };
}
