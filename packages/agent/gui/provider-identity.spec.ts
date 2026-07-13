import { describe, expect, it } from "vitest";
import { resolveAgentGUIProviderIdentity } from "./provider-identity.ts";

describe("provider identity public seam", () => {
  it("projects migrated aliases without exposing catalog internals", () => {
    expect(resolveAgentGUIProviderIdentity("open-code")).toEqual({
      providerId: "opencode",
      displayName: "OpenCode",
      iconKey: "opencode",
      targetId: "local:opencode"
    });
  });

  it("projects legacy identities during the migration window", () => {
    expect(resolveAgentGUIProviderIdentity("claude")).toEqual({
      providerId: "claude-code",
      displayName: "Claude Code",
      iconKey: "claude-code",
      targetId: "local:claude-code"
    });
  });

  it("returns null for unknown providers", () => {
    expect(resolveAgentGUIProviderIdentity("unknown-provider")).toBeNull();
  });
});
