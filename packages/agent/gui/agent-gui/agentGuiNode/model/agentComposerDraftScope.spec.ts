import { describe, expect, it } from "vitest";
import {
  AGENT_COMPOSER_NO_PROJECT_SCOPE,
  normalizeAgentComposerDraftProjectPath,
  resolveAgentComposerDraftScopeKey
} from "./agentComposerDraftScope";

describe("agentComposerDraftScope", () => {
  it("uses one project scope regardless of provider or model selection", () => {
    const projectPath = "/workspace/project-a";

    expect(resolveAgentComposerDraftScopeKey({ projectPath })).toBe(
      "project:/workspace/project-a"
    );
    expect(resolveAgentComposerDraftScopeKey({ projectPath })).toBe(
      resolveAgentComposerDraftScopeKey({ projectPath })
    );
  });

  it("keeps different project drafts isolated", () => {
    expect(
      resolveAgentComposerDraftScopeKey({ projectPath: "/workspace/a" })
    ).not.toBe(
      resolveAgentComposerDraftScopeKey({ projectPath: "/workspace/b" })
    );
  });

  it("normalizes project separators and trailing slashes", () => {
    expect(normalizeAgentComposerDraftProjectPath(" C:\\repo\\app\\ ")).toBe(
      "C:/repo/app"
    );
    expect(
      resolveAgentComposerDraftScopeKey({ projectPath: "/workspace/app///" })
    ).toBe("project:/workspace/app");
    expect(normalizeAgentComposerDraftProjectPath("/")).toBe("/");
    expect(normalizeAgentComposerDraftProjectPath("///")).toBe("/");
    expect(normalizeAgentComposerDraftProjectPath("C:\\")).toBe("C:/");
    expect(normalizeAgentComposerDraftProjectPath("C:\\\\\\")).toBe("C:/");
  });

  it("uses a stable scope when no project is selected", () => {
    expect(resolveAgentComposerDraftScopeKey({ projectPath: null })).toBe(
      AGENT_COMPOSER_NO_PROJECT_SCOPE
    );
    expect(resolveAgentComposerDraftScopeKey({ projectPath: "  " })).toBe(
      AGENT_COMPOSER_NO_PROJECT_SCOPE
    );
  });

  it("gives an existing session precedence over project identity", () => {
    expect(
      resolveAgentComposerDraftScopeKey({
        agentSessionId: " session-1 ",
        projectPath: "/workspace/project-a"
      })
    ).toBe("session:session-1");
  });
});
