import { describe, expect, it } from "vitest";
import {
  AGENT_COMPOSER_HOME_DRAFT_SCOPE,
  areAgentComposerProjectPathsEqual,
  isAgentComposerSessionDraftScope,
  normalizeAgentComposerDraftProjectPath,
  resolveAgentComposerDraftScopeKey
} from "./agentComposerDraftScope";

describe("agentComposerDraftScope", () => {
  it("shares one home draft across projects, providers, and empty selection", () => {
    expect(
      resolveAgentComposerDraftScopeKey({ projectPath: "/workspace/project-a" })
    ).toBe(AGENT_COMPOSER_HOME_DRAFT_SCOPE);
    expect(
      resolveAgentComposerDraftScopeKey({ projectPath: "/workspace/project-b" })
    ).toBe(AGENT_COMPOSER_HOME_DRAFT_SCOPE);
    expect(resolveAgentComposerDraftScopeKey({ projectPath: null })).toBe(
      AGENT_COMPOSER_HOME_DRAFT_SCOPE
    );
    expect(resolveAgentComposerDraftScopeKey({ projectPath: "  " })).toBe(
      AGENT_COMPOSER_HOME_DRAFT_SCOPE
    );
    expect(resolveAgentComposerDraftScopeKey({})).toBe(
      AGENT_COMPOSER_HOME_DRAFT_SCOPE
    );
  });

  it("normalizes project separators and trailing slashes for selected path", () => {
    expect(normalizeAgentComposerDraftProjectPath(" C:\\repo\\app\\ ")).toBe(
      "C:/repo/app"
    );
    expect(normalizeAgentComposerDraftProjectPath("/workspace/app///")).toBe(
      "/workspace/app"
    );
    expect(normalizeAgentComposerDraftProjectPath("/")).toBe("/");
    expect(normalizeAgentComposerDraftProjectPath("///")).toBe("/");
    expect(normalizeAgentComposerDraftProjectPath("C:\\")).toBe("C:/");
    expect(normalizeAgentComposerDraftProjectPath("C:\\\\\\")).toBe("C:/");
  });

  it("matches Windows project metadata despite slash style and casing", () => {
    expect(
      areAgentComposerProjectPathsEqual(
        "C:\\Users\\Demo\\Repo",
        "c:/users/demo/repo/"
      )
    ).toBe(true);
  });

  it("gives an existing session precedence over the shared home draft", () => {
    expect(
      resolveAgentComposerDraftScopeKey({
        agentSessionId: " session-1 ",
        projectPath: "/workspace/project-a"
      })
    ).toBe("session:session-1");
  });

  it("treats only session-prefixed keys as session drafts", () => {
    expect(isAgentComposerSessionDraftScope("session:session-1")).toBe(true);
    expect(
      isAgentComposerSessionDraftScope(AGENT_COMPOSER_HOME_DRAFT_SCOPE)
    ).toBe(false);
    expect(isAgentComposerSessionDraftScope("project:/workspace/app")).toBe(
      false
    );
  });
});
