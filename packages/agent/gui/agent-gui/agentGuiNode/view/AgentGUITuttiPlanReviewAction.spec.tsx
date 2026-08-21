import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentGUITuttiPlanReviewAction,
  AgentGUITuttiPlanReviewActionSlot
} from "./AgentGUITuttiPlanReviewAction";

describe("AgentGUITuttiPlanReviewAction", () => {
  it("renders the localized request-changes action and dispatches it explicitly", () => {
    const onRequestChanges = vi.fn();
    render(
      <AgentGUITuttiPlanReviewAction
        label="请求修改"
        onRequestChanges={onRequestChanges}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "请求修改" }));

    expect(onRequestChanges).toHaveBeenCalledTimes(1);
  });

  it("shows the request-changes action only for a divergent empty plan review", () => {
    const onRequestChanges = vi.fn();
    const controller = {
      planReviewDraftHasContent: false,
      planReviewPreferencesDiverged: true,
      planReviewSendActive: true,
      requestPendingPlanChanges: onRequestChanges
    };
    const { rerender } = render(
      <AgentGUITuttiPlanReviewActionSlot
        controller={controller}
        label="请求修改"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "请求修改" }));
    expect(onRequestChanges).toHaveBeenCalledTimes(1);

    rerender(
      <AgentGUITuttiPlanReviewActionSlot
        controller={{ ...controller, planReviewPreferencesDiverged: false }}
        label="请求修改"
      />
    );
    expect(
      screen.queryByRole("button", { name: "请求修改" })
    ).not.toBeInTheDocument();

    rerender(
      <AgentGUITuttiPlanReviewActionSlot
        controller={{ ...controller, planReviewSendActive: false }}
        label="请求修改"
      />
    );
    expect(
      screen.queryByRole("button", { name: "请求修改" })
    ).not.toBeInTheDocument();

    rerender(
      <AgentGUITuttiPlanReviewActionSlot
        controller={{ ...controller, planReviewDraftHasContent: true }}
        label="请求修改"
      />
    );
    expect(
      screen.queryByRole("button", { name: "请求修改" })
    ).not.toBeInTheDocument();
  });
});
