import { describe, expect, it } from "vitest";
import { resolveAgentMentionTargetPresentation } from "./agentTargetPresentation";

describe("resolveAgentMentionTargetPresentation", () => {
  it("prefers the exact workspace target over stale serialized metadata", () => {
    expect(
      resolveAgentMentionTargetPresentation({
        agentTargetId: "extension:gemini",
        agentTargets: [
          {
            agentTargetId: "extension:gemini",
            iconUrl: "current-icon",
            name: "Gemini CLI",
            provider: "acp:gemini",
            workspaceId: "workspace-1"
          }
        ],
        fallbackIconUrl: "stale-icon",
        fallbackName: "Old Gemini",
        fallbackProvider: "all-agents",
        workspaceId: "workspace-1"
      })
    ).toMatchObject({
      iconUrl: "current-icon",
      name: "Gemini CLI",
      provider: "acp:gemini"
    });
  });

  it("keeps the supplied provider fallback when the directory has no match", () => {
    const presentation = resolveAgentMentionTargetPresentation({
      agentTargetId: "local:codex",
      agentTargets: [],
      fallbackProvider: "codex"
    });

    expect(presentation.provider).toBe("codex");
    expect(presentation.iconUrl).toContain("codex");
    expect(presentation.target).toBeNull();
  });
});
