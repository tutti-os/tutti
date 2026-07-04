import { describe, expect, it } from "vitest";
import { normalizeWorkspaceAgentStatus } from "./workspaceAgentStatusNormalizer";

describe("normalizeWorkspaceAgentStatus", () => {
  it("lets the current turn phase override a stale session failure", () => {
    expect(
      normalizeWorkspaceAgentStatus({
        lifecycleStatus: "failed",
        status: "failed",
        currentPhase: "working"
      })
    ).toEqual({ kind: "working" });
  });

  it("keeps failed when the latest phase is failed", () => {
    expect(
      normalizeWorkspaceAgentStatus({
        lifecycleStatus: "failed",
        status: "failed",
        currentPhase: "failed"
      })
    ).toEqual({ kind: "failed" });
  });
});
