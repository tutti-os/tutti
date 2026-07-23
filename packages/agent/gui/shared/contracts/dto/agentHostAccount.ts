export interface AgentHostMockSession {
  name: string;
  userId: string;
  email?: string;
  assetUrl?: string;
  assetRef?: string;
}

export const UNAUTHENTICATED_AGENT_HOST_MOCK_SESSION: AgentHostMockSession = {
  name: "Guest",
  userId: "guest"
};

export function createUnauthenticatedAgentHostMockSession(): AgentHostMockSession {
  return { ...UNAUTHENTICATED_AGENT_HOST_MOCK_SESSION };
}

export function isUnauthenticatedAgentHostMockSession(
  session: AgentHostMockSession | null | undefined
): boolean {
  const userId = session?.userId?.trim() ?? "";
  if (!userId) {
    return true;
  }

  return userId === UNAUTHENTICATED_AGENT_HOST_MOCK_SESSION.userId;
}

export interface AgentHostBetaAccess {
  userId: string;
  appId: string;
  status: string;
  grantedAt?: string;
}

export interface AgentHostCheckBetaAccessResult {
  inBeta: boolean;
  betaAccess?: AgentHostBetaAccess | null;
}

export interface AgentHostBetaInviteCode {
  id: string;
  code: string;
  status: string;
  usedBy?: string;
  appId?: string;
}

export interface AgentHostConsumeBetaInviteCodeInput {
  code: string;
}

export interface AgentHostConsumeBetaInviteCodeResult {
  success: boolean;
  message?: string;
  inviteCode?: AgentHostBetaInviteCode | null;
}

export interface AgentHostUserInfo {
  userId: string;
  email?: string;
  assetUrl?: string;
  assetRef?: string;
  name?: string;
}

export interface AgentHostBatchUserInfoInput {
  userIds: string[];
}

export interface AgentHostBatchUserInfoResult {
  users: AgentHostUserInfo[];
}

export interface AgentHostUpdateUserProfileInput {
  name?: string;
  assetUrl?: string;
  assetRef?: string;
}

export const TSH_DESKTOP_MAX_USER_DISPLAY_NAME_LENGTH = 32;

export function normalizeAgentHostUserDisplayName(name: string): string {
  return Array.from(name.trim())
    .slice(0, TSH_DESKTOP_MAX_USER_DISPLAY_NAME_LENGTH)
    .join("");
}

export type AgentHostAccountAuthStatus = "authenticated" | "unauthenticated";

export type AgentHostAccountUserProfile = AgentHostUserInfo;

export interface AgentHostAccountSnapshot {
  authStatus: AgentHostAccountAuthStatus;
  currentUserId: string | null;
  currentUser: AgentHostAccountUserProfile | null;
  profilesByUserId: Record<string, AgentHostAccountUserProfile>;
}

export interface AgentHostEnsureAccountProfilesInput {
  userIds: string[];
}
