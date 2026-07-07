import type { DesktopRichTextAtCapability } from "@renderer/features/rich-text-at";

const workspaceIssueManagerRichTextTriggerCapabilities = [
  "agent-target",
  "workspace-app"
] as const satisfies readonly DesktopRichTextAtCapability[];

export function createWorkspaceIssueManagerRichTextTriggerProviderRequestFromIdentity(input: {
  currentUser: () => { userId: string };
  surface: string;
  workspaceId: string;
}) {
  return {
    capabilities: workspaceIssueManagerRichTextTriggerCapabilities,
    metadata: {
      currentUserId: input.currentUser().userId
    },
    surface: input.surface,
    target: "issue-manager",
    workspaceId: input.workspaceId
  };
}
