import { afterEach, describe, expect, it } from "vitest";
import {
  getAgentCustomMentionKind,
  registerAgentCustomMentionKind,
  resetAgentCustomMentionKindsForTests
} from "./agentCustomMentionKinds";

afterEach(() => {
  resetAgentCustomMentionKindsForTests();
});

describe("registerAgentCustomMentionKind", () => {
  it("registers and looks up kinds case-insensitively", () => {
    registerAgentCustomMentionKind({
      kind: "External-Note",
      present: (mention) => ({ name: mention.label })
    });
    expect(getAgentCustomMentionKind("external-note")).toBeDefined();
    expect(getAgentCustomMentionKind("EXTERNAL-NOTE")).toBeDefined();
  });

  it("rejects empty kinds", () => {
    expect(() =>
      registerAgentCustomMentionKind({
        kind: "  ",
        present: (mention) => ({ name: mention.label })
      })
    ).toThrowError(/non-empty provider id/);
  });

  it("rejects kinds colliding with built-in provider ids", () => {
    for (const reserved of [
      "agent-session",
      "workspace-app",
      "Workspace-Issue",
      "workspace-reference",
      "custom"
    ]) {
      expect(() =>
        registerAgentCustomMentionKind({
          kind: reserved,
          present: (mention) => ({ name: mention.label })
        })
      ).toThrowError(/collides with a built-in provider id/);
      expect(getAgentCustomMentionKind(reserved)).toBeUndefined();
    }
  });
});
