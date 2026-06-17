import type {
  IssueManagerIdentityAdapter,
  IssueManagerIdentityProfile
} from "@tutti-os/workspace-issue-manager/contracts";

export interface DesktopIssueManagerIdentityAdapter extends IssueManagerIdentityAdapter {
  currentUser(): IssueManagerIdentityProfile;
}

export function createDesktopIssueManagerIdentityAdapter(): DesktopIssueManagerIdentityAdapter {
  return {
    currentUser() {
      return {
        displayName: "Local",
        userId: "local"
      };
    }
  };
}
