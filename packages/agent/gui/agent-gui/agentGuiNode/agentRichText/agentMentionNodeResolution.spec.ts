import { describe, expect, it } from "vitest";
import {
  parseResolvableAgentMentionIdentity,
  resolveAgentMentionNodePresentation
} from "./agentMentionNodeResolution";

describe("agentMentionNodeResolution", () => {
  it("parses the complete canonical identity for a resolvable Composer mention", () => {
    expect(
      parseResolvableAgentMentionIdentity(
        {
          href: "mention://workspace-issue/issue-1?projectId=project-1&workspaceId=workspace-1",
          name: "Task Center"
        },
        "workspace-issue"
      )
    ).toEqual({
      entityId: "issue-1",
      label: "Task Center",
      providerId: "workspace-issue",
      scope: {
        projectId: "project-1",
        workspaceId: "workspace-1"
      },
      trigger: "@"
    });
  });

  it("does not resolve mention kinds outside the Composer presentation seam", () => {
    expect(
      parseResolvableAgentMentionIdentity(
        {
          href: "mention://agent-session/session-1?workspaceId=workspace-1",
          name: "Session"
        },
        "session"
      )
    ).toBeNull();
  });

  it.each(["missing", "error"] as const)(
    "clears stale presentation attrs when resolution becomes %s",
    (state) => {
      expect(
        resolveAgentMentionNodePresentation({
          attrs: {
            agentProviderId: "stale-provider",
            iconUrl: "https://icons.example/stale.png",
            name: "Weather"
          },
          hasMentionService: true,
          state
        })
      ).toEqual({ label: "Weather" });
    }
  );

  it("clears stale presentation attrs when the mention service is removed", () => {
    expect(
      resolveAgentMentionNodePresentation({
        attrs: {
          agentProviderId: "stale-provider",
          iconUrl: "https://icons.example/stale.png",
          name: "Weather"
        },
        hasMentionService: false,
        state: "ready"
      })
    ).toEqual({ label: "Weather" });
  });

  it("does not retain omitted provider or icon fields from a ready resolution", () => {
    expect(
      resolveAgentMentionNodePresentation({
        attrs: {
          agentProviderId: "stale-provider",
          iconUrl: "https://icons.example/stale.png",
          name: "Weather"
        },
        hasMentionService: true,
        resolved: { label: "@Resolved Weather" },
        state: "ready"
      })
    ).toEqual({
      agentProviderId: undefined,
      iconUrl: undefined,
      label: "Resolved Weather"
    });
  });

  it.each([
    [
      "iconUrl",
      { iconUrl: "https://icons.example/app.png" },
      "https://icons.example/app.png"
    ],
    [
      "thumbnailUrl",
      { thumbnailUrl: "https://icons.example/issue.png" },
      "https://icons.example/issue.png"
    ],
    [
      "agentIconUrl",
      { agentIconUrl: "https://icons.example/agent.png" },
      "https://icons.example/agent.png"
    ]
  ] as const)(
    "uses resolved %s presentation without attrs fallback",
    (_, presentation, expectedIconUrl) => {
      expect(
        resolveAgentMentionNodePresentation({
          attrs: {
            iconUrl: "https://icons.example/stale.png",
            name: "Mention"
          },
          hasMentionService: true,
          resolved: { presentation },
          state: "ready"
        }).iconUrl
      ).toBe(expectedIconUrl);
    }
  );
});
