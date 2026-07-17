import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentGUIAgentTargetName } from "./AgentGUIAgentTargetName";

describe("AgentGUIAgentTargetName", () => {
  it("lets only the shared owner shrink while preserving the agent suffix", () => {
    render(
      <AgentGUIAgentTargetName
        ownerSeparator=" 的 "
        target={{
          targetId: "shared-agent:alice-codex",
          agentTargetId: "shared-agent:alice-codex",
          provider: "codex",
          ref: { kind: "agent-directory", provider: "codex" },
          label: "Codex",
          ownerLabel: "我是超长名称的用户我是超长名称的用户",
          ownership: "shared"
        }}
      />
    );

    expect(screen.getByTestId("agent-target-owner-name")).toHaveClass(
      "truncate"
    );
    expect(screen.getByTestId("agent-target-name-suffix")).toHaveClass(
      "shrink-0"
    );
    expect(screen.getByTestId("agent-target-name-suffix").textContent).toBe(
      " 的 Codex"
    );
    expect(
      screen.getByTitle("我是超长名称的用户我是超长名称的用户 的 Codex")
    ).toBeInTheDocument();
  });

  it("renders a local agent as one truncatable label", () => {
    render(
      <AgentGUIAgentTargetName
        ownerSeparator=" 的 "
        target={{
          targetId: "local:codex",
          provider: "codex",
          ref: { kind: "local", provider: "codex" },
          label: "Codex"
        }}
      />
    );

    expect(screen.queryByTestId("agent-target-owner-name")).toBeNull();
    expect(screen.getByTestId("agent-target-name")).toHaveClass("truncate");
  });
});
