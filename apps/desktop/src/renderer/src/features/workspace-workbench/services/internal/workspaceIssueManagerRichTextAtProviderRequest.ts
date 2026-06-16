import type { DesktopRichTextAtCapability } from "@renderer/features/rich-text-at";

export const workspaceIssueManagerRichTextAtCapabilities = [
  "workspace-file",
  "workspace-issue",
  "agent-session",
  "workspace-app"
] as const satisfies readonly DesktopRichTextAtCapability[];

export function createWorkspaceIssueManagerRichTextAtProviderRequest(input: {
  currentUserId: string;
  surface: string;
  workspaceId: string;
}) {
  return {
    capabilities: workspaceIssueManagerRichTextAtCapabilities,
    metadata: { currentUserId: input.currentUserId },
    surface: input.surface,
    target: "issue-manager",
    workspaceId: input.workspaceId
  };
}

export function createWorkspaceIssueManagerRichTextAtProviderRequestFromIdentity(input: {
  currentUser: () => { userId: string };
  surface: string;
  workspaceId: string;
}) {
  return createWorkspaceIssueManagerRichTextAtProviderRequest({
    currentUserId: input.currentUser().userId,
    surface: input.surface,
    workspaceId: input.workspaceId
  });
}
