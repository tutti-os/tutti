import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentGUIAgentTarget,
  AgentGUIProviderUpdateNotice
} from "../../../types";
import { AgentGUIProviderUpdateNotices } from "./AgentGUIProviderUpdateNotices";

vi.mock("../../../i18n/index", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const copy: Record<string, string> = {
        "agentHost.agentGui.updateNoticeCompleted": `Updated to ${values?.version ?? ""}`,
        "agentHost.agentGui.updateNoticeCompletedTitle": `${values?.agent ?? ""} updated successfully`,
        "agentHost.agentGui.updateNoticeDetails": "View details",
        "agentHost.agentGui.updateNoticeFailed": "Update failed",
        "agentHost.agentGui.updateNoticeLater": "Later",
        "agentHost.agentGui.updateNoticeRegionLabel": "Agent CLI updates",
        "agentHost.agentGui.updateNoticeRetry": "Retry",
        "agentHost.agentGui.updateNoticeTitle": `A new version of ${values?.agent ?? ""} is available`,
        "agentHost.agentGui.updateNoticeUpdate": "Update",
        "agentHost.agentGui.updateNoticeUpdating": "Updating…",
        "agentHost.agentGui.updateNoticeVersions": `Current ${values?.current ?? ""} · Available ${values?.latest ?? ""}`
      };
      return copy[key] ?? key;
    }
  })
}));

const target: AgentGUIAgentTarget = {
  agentTargetId: "local:codex",
  iconUrl: "codex.svg",
  label: "Codex",
  provider: "codex",
  ref: { kind: "local", provider: "codex" },
  targetId: "local:codex"
};

describe("AgentGUIProviderUpdateNotices", () => {
  it("shows the exact Agent and version transition with all user choices", () => {
    const onAction = vi.fn();
    const notice = createNotice();
    render(
      <AgentGUIProviderUpdateNotices
        agentTargets={[target]}
        notices={[notice]}
        onAction={onAction}
        ownerSeparator="'s"
      />
    );

    expect(
      screen.getByText("A new version of Codex is available")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Current 1.2.3 · Available 1.3.0")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    fireEvent.click(screen.getByRole("button", { name: "View details" }));

    expect(onAction.mock.calls.map(([input]) => input.action)).toEqual([
      "update",
      "later",
      "details"
    ]);
    expect(onAction).toHaveBeenCalledWith({ action: "update", notice });
  });

  it("renders updating, failed, and completed states without dead-end actions", () => {
    const onAction = vi.fn();
    const { rerender } = render(
      <AgentGUIProviderUpdateNotices
        agentTargets={[target]}
        notices={[createNotice("updating")]}
        onAction={onAction}
        ownerSeparator="'s"
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Updating…");
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Later" })).toBeNull();

    rerender(
      <AgentGUIProviderUpdateNotices
        agentTargets={[target]}
        notices={[createNotice("failed")]}
        onAction={onAction}
        ownerSeparator="'s"
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Update failed");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Later" })).toBeEnabled();

    rerender(
      <AgentGUIProviderUpdateNotices
        agentTargets={[target]}
        notices={[createNotice("completed")]}
        onAction={onAction}
        ownerSeparator="'s"
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Updated to 1.3.0");
    expect(screen.getByText("Codex updated successfully")).toBeInTheDocument();
    expect(screen.queryByText("Current 1.2.3 · Available 1.3.0")).toBeNull();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Later" })).toBeNull();
    expect(screen.getByRole("button", { name: "View details" })).toBeEnabled();
  });

  it("renders nothing without an update for a resolvable exact target", () => {
    const { rerender } = render(
      <AgentGUIProviderUpdateNotices
        agentTargets={[target]}
        notices={[]}
        ownerSeparator="'s"
      />
    );
    expect(screen.queryByRole("region")).toBeNull();

    rerender(
      <AgentGUIProviderUpdateNotices
        agentTargets={[]}
        notices={[createNotice()]}
        ownerSeparator="'s"
      />
    );
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("fails closed when the Host omits the paired action", () => {
    render(
      <AgentGUIProviderUpdateNotices
        agentTargets={[target]}
        notices={[createNotice()]}
        ownerSeparator="'s"
      />
    );

    expect(screen.queryByRole("region")).toBeNull();
  });
});

function createNotice(
  phase: AgentGUIProviderUpdateNotice["phase"] = "available"
): AgentGUIProviderUpdateNotice {
  return {
    agentTargetId: "local:codex",
    currentVersion: "1.2.3",
    latestVersion: "1.3.0",
    phase
  };
}
