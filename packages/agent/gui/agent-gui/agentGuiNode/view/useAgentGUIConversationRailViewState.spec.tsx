import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentGUIConversationRailViewState } from "./useAgentGUIConversationRailViewState";

interface HarnessProps {
  actionsRef?: {
    current: HarnessActions | null;
  };
  activeConversationId: string | null;
  contentReady: boolean;
  identity: string;
  itemIds: string[];
  revealRequest?: {
    agentSessionId: string;
    reason: "created" | "external-open";
    revision: number;
  } | null;
  searchQuery?: string;
  scopeKey: string;
}

interface HarnessActions {
  setSectionVisibleItemLimit: (sectionId: string, limit: number) => void;
  toggleProjectSectionCollapsed: (sectionId: string) => void;
}

const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView
  });
});

describe("useAgentGUIConversationRailViewState", () => {
  it("restores target scroll only after exact scope content settles", () => {
    const view = render(
      <Harness
        activeConversationId="codex-session"
        contentReady
        identity="codex-list"
        itemIds={["codex-session"]}
        scopeKey="codex"
      />
    );
    const viewport = screen.getByTestId("viewport");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    viewport.scrollTop = 240;
    fireEvent.scroll(viewport);

    view.rerender(
      <Harness
        activeConversationId="codex-session"
        contentReady={false}
        identity="codex-list"
        itemIds={["codex-session"]}
        scopeKey="claude"
      />
    );
    expect(viewport.scrollTop).toBe(240);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    view.rerender(
      <Harness
        activeConversationId="claude-session"
        contentReady
        identity="claude-list"
        itemIds={["claude-session"]}
        scopeKey="claude"
      />
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    viewport.scrollTop = 80;
    fireEvent.scroll(viewport);
    scrollIntoView.mockClear();

    view.rerender(
      <Harness
        activeConversationId="claude-session"
        contentReady={false}
        identity="claude-list"
        itemIds={["claude-session"]}
        scopeKey="codex"
      />
    );

    expect(viewport.scrollTop).toBe(80);
    expect(scrollIntoView).not.toHaveBeenCalled();

    view.rerender(
      <Harness
        activeConversationId="claude-session"
        contentReady
        identity="codex-list"
        itemIds={["codex-session"]}
        scopeKey="codex"
      />
    );

    expect(viewport.scrollTop).toBe(240);
    expect(scrollIntoView).not.toHaveBeenCalled();

    view.rerender(
      <Harness
        activeConversationId="codex-session"
        contentReady
        identity="codex-list"
        itemIds={["codex-session"]}
        scopeKey="codex"
      />
    );
    expect(viewport.scrollTop).toBe(240);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("waits for settled content before revealing a first-visit active session", () => {
    const view = render(
      <Harness
        activeConversationId="cursor-session"
        contentReady={false}
        identity="cursor-loading"
        itemIds={["cursor-session"]}
        scopeKey="cursor"
      />
    );
    expect(scrollIntoView).not.toHaveBeenCalled();

    view.rerender(
      <Harness
        activeConversationId="cursor-session"
        contentReady
        identity="cursor-ready"
        itemIds={["cursor-session"]}
        scopeKey="cursor"
      />
    );

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("does not treat active selection changes as scroll commands", () => {
    const view = render(
      <Harness
        activeConversationId="session-1"
        contentReady
        identity="list-1"
        itemIds={["session-1", "session-2"]}
        scopeKey="codex"
      />
    );
    scrollIntoView.mockClear();

    view.rerender(
      <Harness
        activeConversationId="session-2"
        contentReady
        identity="list-1"
        itemIds={["session-1", "session-2"]}
        scopeKey="codex"
      />
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not read scroll geometry while replacing a settled navigation effect", () => {
    const view = render(
      <Harness
        activeConversationId={null}
        contentReady
        identity="list-1"
        itemIds={[]}
        scopeKey="codex"
      />
    );
    const viewport = screen.getByTestId("viewport");
    let scrollTop = 240;
    const readScrollTop = vi.fn(() => scrollTop);
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: readScrollTop,
      set: (value: number) => {
        scrollTop = value;
      }
    });

    fireEvent.scroll(viewport);
    expect(readScrollTop).toHaveBeenCalledTimes(1);
    readScrollTop.mockClear();

    view.rerender(
      <Harness
        activeConversationId="session-1"
        contentReady
        identity="list-1"
        itemIds={["session-1"]}
        scopeKey="codex"
      />
    );

    expect(readScrollTop).not.toHaveBeenCalled();
  });

  it("reveals only an explicit navigation request within a settled target", () => {
    const view = render(
      <Harness
        activeConversationId="session-1"
        contentReady
        identity="list-1"
        itemIds={["session-1", "session-2"]}
        scopeKey="codex"
      />
    );
    scrollIntoView.mockClear();

    view.rerender(
      <Harness
        activeConversationId="session-2"
        contentReady
        identity="list-1"
        itemIds={["session-1", "session-2"]}
        revealRequest={{
          agentSessionId: "session-2",
          reason: "external-open",
          revision: 1
        }}
        scopeKey="codex"
      />
    );

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(
      screen.getByTestId("session-2")
    );
  });

  it("keeps search transient and restores browse scroll on exit", () => {
    const view = render(
      <Harness
        activeConversationId={null}
        contentReady
        identity="codex-list"
        itemIds={[]}
        scopeKey="codex"
      />
    );
    const viewport = screen.getByTestId("viewport");
    viewport.scrollTop = 240;
    fireEvent.scroll(viewport);

    view.rerender(
      <Harness
        activeConversationId="codex-session"
        contentReady
        identity="codex-search"
        itemIds={[]}
        searchQuery="issue"
        scopeKey="codex"
      />
    );

    expect(viewport.scrollTop).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();

    viewport.scrollTop = 50;
    fireEvent.scroll(viewport);
    view.rerender(
      <Harness
        activeConversationId="codex-session"
        contentReady
        identity="codex-list"
        itemIds={["codex-session"]}
        scopeKey="codex"
      />
    );

    expect(viewport.scrollTop).toBe(240);
  });

  it("restores section view state independently for each target", () => {
    const view = render(
      <Harness
        activeConversationId={null}
        contentReady
        identity="codex-list"
        itemIds={[]}
        scopeKey="codex"
      />
    );
    act(() => {
      screen.getByRole("button", { name: "toggle section" }).click();
      screen.getByRole("button", { name: "show more" }).click();
    });
    expect(screen.getByTestId("section-state")).toHaveAttribute(
      "data-collapsed",
      "true"
    );
    expect(screen.getByTestId("section-state")).toHaveAttribute(
      "data-limit",
      "10"
    );

    view.rerender(
      <Harness
        activeConversationId={null}
        contentReady
        identity="claude-list"
        itemIds={[]}
        scopeKey="claude"
      />
    );
    expect(screen.getByTestId("section-state")).toHaveAttribute(
      "data-collapsed",
      "false"
    );
    expect(screen.getByTestId("section-state")).toHaveAttribute(
      "data-limit",
      "5"
    );

    view.rerender(
      <Harness
        activeConversationId={null}
        contentReady
        identity="codex-list"
        itemIds={[]}
        scopeKey="codex"
      />
    );
    expect(screen.getByTestId("section-state")).toHaveAttribute(
      "data-collapsed",
      "true"
    );
    expect(screen.getByTestId("section-state")).toHaveAttribute(
      "data-limit",
      "10"
    );
  });

  it("keeps section actions stable and applies them to the latest target", () => {
    const actionsRef: HarnessProps["actionsRef"] = { current: null };
    const view = render(
      <Harness
        actionsRef={actionsRef}
        activeConversationId={null}
        contentReady
        identity="codex-list"
        itemIds={[]}
        scopeKey="codex"
      />
    );
    const firstActions = actionsRef.current!;

    view.rerender(
      <Harness
        actionsRef={actionsRef}
        activeConversationId={null}
        contentReady
        identity="claude-list"
        itemIds={[]}
        scopeKey="claude"
      />
    );

    expect(actionsRef.current?.setSectionVisibleItemLimit).toBe(
      firstActions.setSectionVisibleItemLimit
    );
    expect(actionsRef.current?.toggleProjectSectionCollapsed).toBe(
      firstActions.toggleProjectSectionCollapsed
    );
    act(() => {
      firstActions.toggleProjectSectionCollapsed("project-1");
      firstActions.setSectionVisibleItemLimit("project-1", 10);
    });
    expect(screen.getByTestId("section-state")).toHaveAttribute(
      "data-collapsed",
      "true"
    );
    expect(screen.getByTestId("section-state")).toHaveAttribute(
      "data-limit",
      "10"
    );

    view.rerender(
      <Harness
        actionsRef={actionsRef}
        activeConversationId={null}
        contentReady
        identity="codex-list"
        itemIds={[]}
        scopeKey="codex"
      />
    );
    expect(screen.getByTestId("section-state")).toHaveAttribute(
      "data-collapsed",
      "false"
    );
    expect(screen.getByTestId("section-state")).toHaveAttribute(
      "data-limit",
      "5"
    );
  });
});

function Harness({
  actionsRef,
  activeConversationId,
  contentReady,
  identity,
  itemIds,
  revealRequest = null,
  searchQuery = "",
  scopeKey
}: HarnessProps): React.JSX.Element {
  const state = useAgentGUIConversationRailViewState({
    activeConversationId,
    contentReady,
    groupedConversationIdentityKey: identity,
    revealRequest,
    searchQuery,
    scopeKey
  });
  if (actionsRef) {
    actionsRef.current = {
      setSectionVisibleItemLimit: state.setSectionVisibleItemLimit,
      toggleProjectSectionCollapsed: state.toggleProjectSectionCollapsed
    };
  }
  return (
    <div>
      <div data-testid="viewport" ref={state.conversationListRef}>
        {itemIds.map((itemId) => (
          <div
            data-testid={itemId}
            key={itemId}
            ref={(element) =>
              state.registerConversationItemElement(itemId, element)
            }
          />
        ))}
      </div>
      <div
        data-testid="section-state"
        data-collapsed={state.collapsedSectionIds.has("project-1")}
        data-limit={state.visibleItemLimitForSection("project-1")}
      />
      <button
        type="button"
        onClick={() => state.toggleProjectSectionCollapsed("project-1")}
      >
        toggle section
      </button>
      <button
        type="button"
        onClick={() =>
          state.setSectionVisibleItemLimit(
            "project-1",
            state.visibleItemLimitForSection("project-1") + 5
          )
        }
      >
        show more
      </button>
    </div>
  );
}
