import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentFullAccessRestoredWarning } from "./AgentFullAccessRestoredWarning";
import { CODEX_FULL_ACCESS_WARNING_ACKNOWLEDGEMENT_STORAGE_KEY } from "./view/agentFullAccessWarningPreference";

describe("AgentFullAccessRestoredWarning", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it("warns for an unacknowledged Codex full-access home default", () => {
    renderWarning();

    expect(screen.getByRole("alert")).toHaveTextContent("Full access is on");
  });

  it("does not warn for another permission mode or provider", () => {
    const { rerender } = renderWarning({ permissionModeId: "auto" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(
      <AgentFullAccessRestoredWarning
        isSettingsLoading={false}
        permissionModeId="full-access"
        provider="opencode"
        visibleOnHome
      />
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not warn in history or while defaults are loading", () => {
    const { rerender } = renderWarning({ visibleOnHome: false });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(
      <AgentFullAccessRestoredWarning
        isSettingsLoading
        permissionModeId="full-access"
        provider="codex"
        visibleOnHome
      />
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("persists Don't show again across mounts", () => {
    const first = renderWarning();
    fireEvent.click(screen.getByRole("button", { name: "Don't show again" }));

    expect(
      globalThis.localStorage.getItem(
        CODEX_FULL_ACCESS_WARNING_ACKNOWLEDGEMENT_STORAGE_KEY
      )
    ).toBe("1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    first.unmount();
    renderWarning();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("dismisses the warning only for the current mount", () => {
    const first = renderWarning();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss full access warning" })
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      globalThis.localStorage.getItem(
        CODEX_FULL_ACCESS_WARNING_ACKNOWLEDGEMENT_STORAGE_KEY
      )
    ).toBeNull();

    first.unmount();
    renderWarning();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

function renderWarning(
  overrides: Partial<
    React.ComponentProps<typeof AgentFullAccessRestoredWarning>
  > = {}
) {
  return render(
    <AgentFullAccessRestoredWarning
      isSettingsLoading={false}
      permissionModeId="full-access"
      provider="codex"
      visibleOnHome
      {...overrides}
    />
  );
}
