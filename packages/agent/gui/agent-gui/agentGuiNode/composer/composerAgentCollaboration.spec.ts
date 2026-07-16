import { describe, expect, it } from "vitest";
import {
  agentCollaborationTargetsFromPrompt,
  collaborationQuestionFromPrompt
} from "./composerAgentCollaboration";

describe("composer Agent collaboration mentions", () => {
  it("extracts and deduplicates only durable Agent target mentions", () => {
    const prompt = [
      "请",
      "[@Reviewer](mention://agent-target/reviewer?workspaceId=workspace-1)",
      "和",
      "[@Reviewer](mention://agent-target/reviewer?workspaceId=workspace-1)",
      "查看",
      "[@Issue](mention://workspace-issue/issue-1?workspaceId=workspace-1)"
    ].join(" ");

    expect(agentCollaborationTargetsFromPrompt(prompt)).toEqual([
      {
        name: "Reviewer",
        targetId: "reviewer",
        workspaceId: "workspace-1"
      }
    ]);
  });

  it("keeps readable Agent labels while removing mention transport URLs", () => {
    const prompt =
      "请 [@Reviewer](mention://agent-target/reviewer?workspaceId=workspace-1) 检查 [@Issue](mention://workspace-issue/issue-1?workspaceId=workspace-1)";

    expect(collaborationQuestionFromPrompt(prompt)).toBe(
      "请 @Reviewer 检查 [@Issue](mention://workspace-issue/issue-1?workspaceId=workspace-1)"
    );
  });
});
