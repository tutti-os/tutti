import { describe, expect, it } from "vitest";
import { managedAgentRoundedIconUrl } from "../../shared/managedAgentIcons";
import {
  buildAgentMentionGroups,
  providerItemToAgentMentionItem
} from "./AgentMentionSearchModel";

describe("providerItemToAgentMentionItem", () => {
  it("keeps file path and workspace context as picker-only presentation", () => {
    expect(
      providerItemToAgentMentionItem({
        currentUserId: "user-1",
        providerId: "file",
        insertResult: {
          href: "/Users/test/project/tutti/src/index.ts",
          kind: "markdown-link",
          label: "index.ts"
        },
        label: "index.ts",
        subtitle: "project/tutti/src · Tutti",
        workspaceId: "workspace-1"
      })
    ).toMatchObject({
      contextLabel: "project/tutti/src · Tutti",
      kind: "file",
      name: "index.ts"
    });
  });

  it("normalizes Windows generated-file paths before deriving their directory", () => {
    const path = "C:\\Users\\agent\\workspace\\generated\\report.md";
    const item = providerItemToAgentMentionItem({
      currentUserId: "user-1",
      providerId: "agent-generated-file",
      insertResult: {
        kind: "mention",
        mention: {
          entityId: path,
          label: "report.md",
          scope: { workspaceId: "workspace-1" }
        }
      },
      label: "report.md",
      subtitle: path,
      workspaceId: "workspace-1"
    });

    expect(item).toMatchObject({
      kind: "file",
      path,
      name: "report.md",
      directoryPath: "C:/Users/agent/workspace/generated"
    });
  });

  it("recognizes native trailing separators as directory provider items", () => {
    const path = "C:\\Users\\agent\\workspace\\generated\\";
    const item = providerItemToAgentMentionItem({
      currentUserId: "user-1",
      providerId: "file",
      insertResult: { kind: "markdown-link", href: path, label: "generated" },
      label: "generated",
      subtitle: path,
      workspaceId: "workspace-1"
    });

    expect(item).toMatchObject({
      kind: "file",
      path,
      name: "generated",
      entryKind: "directory",
      directoryPath: "C:/Users/agent/workspace"
    });
  });

  it("preserves workspace issue icon presentation", () => {
    expect(
      providerItemToAgentMentionItem({
        currentUserId: "user-1",
        providerId: "workspace-issue",
        insertResult: {
          kind: "mention",
          mention: {
            entityId: "issue-1",
            label: "Fix task icon",
            scope: {
              workspaceId: "workspace-1"
            },
            presentation: {
              iconUrl: "tutti-asset://issue/default.png"
            }
          }
        },
        label: "Fix task icon",
        subtitle: "",
        workspaceId: "workspace-1"
      })
    ).toMatchObject({
      iconUrl: "tutti-asset://issue/default.png",
      kind: "workspace-issue"
    });
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
