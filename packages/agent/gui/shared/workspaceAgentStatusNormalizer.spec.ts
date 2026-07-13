import { describe, expect, it } from "vitest";
import { normalizeWorkspaceAgentStatus } from "./workspaceAgentStatusNormalizer";

describe("normalizeWorkspaceAgentStatus", () => {
  it("lets the current turn phase override a stale session failure", () => {
    expect(
      normalizeWorkspaceAgentStatus({
        status: "failed",
        activeTurnPhase: "running"
      })
    ).toEqual({ kind: "working" });
  });

  it("keeps failed when the latest phase is failed", () => {
    expect(
      normalizeWorkspaceAgentStatus({
        status: "failed"
      })
    ).toEqual({ kind: "failed" });
  });
});
