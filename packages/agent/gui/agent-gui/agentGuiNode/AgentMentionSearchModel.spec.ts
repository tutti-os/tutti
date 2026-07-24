import { describe, expect, it } from "vitest";
import { managedAgentRoundedIconUrl } from "../../shared/managedAgentIcons";
import {
  buildAgentMentionGroups,
  providerItemToAgentMentionItem
} from "./AgentMentionSearchModel";

describe("providerItemToAgentMentionItem", () => {
  it("preserves only safe source-relative paths for file presentation", () => {
    const createFile = (subtitle: string) =>
      providerItemToAgentMentionItem({
        currentUserId: "user-1",
        providerId: "file",
        insertResult: {
          kind: "markdown-link",
          href: "/Users/test/project/tutti/docs/README.md",
          label: "README.md"
        },
        label: "README.md",
        subtitle,
        workspaceId: "workspace-1"
      });

    expect(createFile("docs/README.md")).toMatchObject({
      href: "/Users/test/project/tutti/docs/README.md",
      kind: "file",
      name: "README.md",
      relativePath: "docs/README.md"
    });
    expect(
      createFile("/Users/test/project/tutti/docs/README.md")
    ).not.toHaveProperty("relativePath");
    expect(createFile("../outside/README.md")).not.toHaveProperty(
      "relativePath"
    );
  });

  it("preserves Agent Target identity in session mention metadata", () => {
    expect(
      providerItemToAgentMentionItem({
        currentUserId: "user-1",
        providerId: "agent-session",
        insertResult: {
          kind: "mention",
          mention: {
            entityId: "session-1",
            label: "Previous session",
            scope: {
              agentTargetId: "extension:gemini",
              workspaceId: "workspace-1"
            }
          }
        },
        label: "Previous session",
        subtitle: "Gemini CLI",
        workspaceId: "workspace-1"
      })
    ).toMatchObject({
      agentTargetId: "extension:gemini",
      href: "mention://agent-session/session-1?agentTargetId=extension%3Agemini&workspaceId=workspace-1",
      kind: "session"
    });
  });

  it("resolves a Session Agent icon from provider identity instead of its owner-qualified name", () => {
    expect(
      providerItemToAgentMentionItem({
        currentUserId: "user-1",
        providerId: "agent-session",
        insertResult: {
          kind: "mention",
          mention: {
            entityId: "session-1",
            label: "Previous session",
            scope: {
              agentTargetId: "shared-agent:shared-codex",
              workspaceId: "workspace-1"
            },
            presentation: {
              agentProviderId: "codex",
              subtitle: "Lin · Codex (Shared)"
            }
          }
        },
        label: "Previous session",
        subtitle: "Codex",
        workspaceId: "workspace-1"
      })
    ).toMatchObject({
      agentIconUrl: managedAgentRoundedIconUrl("codex"),
      agentName: "Lin · Codex (Shared)",
      kind: "session"
    });
  });

  it("projects structured owner and Agent labels from the provenance catalog", () => {
    const ownerLabel = "A member with a very long display name";
    const initiatorLabel = "Current user";
    const session = providerItemToAgentMentionItem({
      currentUserId: "user-1",
      providerId: "agent-session",
      insertResult: {
        kind: "mention",
        mention: {
          entityId: "session-1",
          label: "Previous session",
          scope: {
            agentTargetId: "shared-agent:shared-codex",
            userId: "user-1",
            workspaceId: "workspace-1"
          },
          presentation: {
            agentProviderId: "codex",
            subtitle: `${ownerLabel} · Codex`
          }
        }
      },
      label: "Previous session",
      subtitle: "Codex",
      workspaceId: "workspace-1"
    });
    expect(session?.kind).toBe("session");
    if (!session || session.kind !== "session") {
      throw new Error("Expected a Session mention item");
    }

    const groups = buildAgentMentionGroups({
      agentGeneratedBrowsePath: null,
      currentFileSearchLimit: 30,
      currentFilter: "session",
      currentQuery: "",
      expandedCounts: {},
      issueTopicGroups: null,
      provenanceCatalog: {
        enabledDimensions: ["agent", "member"],
        agentOptions: [
          {
            id: "shared-agent:shared-codex",
            label: `${ownerLabel} · Codex`,
            parentMemberId: "owner-1"
          }
        ],
        memberOptions: [
          { id: "user-1", label: initiatorLabel },
          { id: "owner-1", label: ownerLabel }
        ]
      },
      provenanceFilter: null,
      rawGroups: {
        agent_generated_files: [],
        agents: [],
        apps: [],
        issues: [],
        opened_files: [],
        sessions: [session]
      },
      totalCounts: {}
    });

    expect(groups[0]?.items[0]).toMatchObject({
      agentLabel: "Codex",
      agentName: `${ownerLabel} · Codex`,
      agentOwnerLabel: ownerLabel,
      initiatorName: initiatorLabel,
      kind: "session"
    });
  });
});
