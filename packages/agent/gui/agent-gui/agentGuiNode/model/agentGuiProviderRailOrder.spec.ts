import { describe, expect, it } from "vitest";
import {
  agentGUIProviderRailOrderStorageKey,
  applyAgentGUIProviderRailOrder,
  parseAgentGUIProviderRailOrder,
  reorderAgentGUIProviderRailOrder,
  serializeAgentGUIProviderRailOrder
} from "./agentGuiProviderRailOrder";

describe("agent gui provider rail order", () => {
  it("scopes the storage key to the workspace", () => {
    expect(agentGUIProviderRailOrderStorageKey("workspace-1")).toBe(
      "agent-gui:provider-rail-order:workspace-1"
    );
    expect(agentGUIProviderRailOrderStorageKey("")).toBe(
      "agent-gui:provider-rail-order:default"
    );
  });

  it("parses and serializes sanitized target ids", () => {
    const serialized = serializeAgentGUIProviderRailOrder([
      " local:codex ",
      "local:codex",
      "",
      "local:claude-code"
    ]);

    expect(serialized).toBe('["local:codex","local:claude-code"]');
    expect(parseAgentGUIProviderRailOrder(serialized)).toEqual([
      "local:codex",
      "local:claude-code"
    ]);
    expect(parseAgentGUIProviderRailOrder("not json")).toEqual([]);
    expect(parseAgentGUIProviderRailOrder('{"order":[]}')).toEqual([]);
  });

  it("applies known target order before unknown targets", () => {
    const codex = { targetId: "local:codex" };
    const claude = { targetId: "local:claude-code" };
    const cursor = { targetId: "local:cursor" };

    expect(
      applyAgentGUIProviderRailOrder(
        [codex, claude, cursor],
        ["local:cursor", "local:codex"]
      )
    ).toEqual([cursor, codex, claude]);
  });

  it("reorders one target around another target", () => {
    const currentTargetIds = [
      "local:codex",
      "local:claude-code",
      "local:cursor"
    ];

    expect(
      reorderAgentGUIProviderRailOrder({
        currentTargetIds,
        draggedTargetId: "local:cursor",
        dropPosition: "before",
        overTargetId: "local:codex"
      })
    ).toEqual(["local:cursor", "local:codex", "local:claude-code"]);
    expect(
      reorderAgentGUIProviderRailOrder({
        currentTargetIds,
        draggedTargetId: "local:codex",
        dropPosition: "after",
        overTargetId: "local:cursor"
      })
    ).toEqual(["local:claude-code", "local:cursor", "local:codex"]);
  });
});
