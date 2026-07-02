import type { DesktopRichTextAtCapability } from "@renderer/features/rich-text-at";

export const workspaceIssueManagerRichTextTriggerCapabilities = [
  "agent-target",
  "workspace-app"
] as const satisfies readonly DesktopRichTextAtCapability[];

export function createWorkspaceIssueManagerRichTextTriggerProviderRequest(input: {
  currentUserId: string;
  surface: string;
  workspaceId: string;
}) {
  return {
    capabilities: workspaceIssueManagerRichTextTriggerCapabilities,
    metadata: { currentUserId: input.currentUserId },
    surface: input.surface,
    target: "issue-manager",
    workspaceId: input.workspaceId
  };
}

export function createWorkspaceIssueManagerRichTextTriggerProviderRequestFromIdentity(input: {
  currentUser: () => { userId: string };
  surface: string;
  workspaceId: string;
}) {
  return createWorkspaceIssueManagerRichTextTriggerProviderRequest({
    currentUserId: input.currentUser().userId,
    surface: input.surface,
    workspaceId: input.workspaceId
  });
}
