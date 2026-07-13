import type { AgentHostRoomRole } from "./agentHostWorkspace";

export type AgentHostRoomShareInviteStatus =
  | "empty"
  | "pending"
  | "used"
  | "revoked";

export interface AgentHostRoomShareMember {
  userId: string;
  displayName?: string;
  email?: string;
  /** Public HTTPS URL for profile image when available (from share state API). */
  avatarUrl?: string;
  role: AgentHostRoomRole;
  joinedAtUnix?: number;
}

export interface AgentHostRoomShareInviteSlot {
  inviteId?: string;
  roomId?: string;
  slotIndex?: number;
  inviteCode?: string;
  status: AgentHostRoomShareInviteStatus;
  createdBy?: string;
  usedBy?: string;
  revokedBy?: string;
  createdAtUnix?: number;
  usedAtUnix?: number;
  revokedAtUnix?: number;
}

export interface AgentHostRoomShareState {
  roomId: string;
  maxCollaborators: number;
  maxActiveInvites: number;
  collaboratorCount: number;
  remainingCollaboratorSlots: number;
  activeInviteCount: number;
  remainingActiveInviteSlots: number;
  members: AgentHostRoomShareMember[];
  invites: AgentHostRoomShareInviteSlot[];
  visitorShareLink?: AgentHostRoomVisitorShareLinkCredential;
}

export interface AgentHostRoomShareStateInput {
  roomId: string;
}

export interface AgentHostRoomVisitorShareLinkState {
  roomId: string;
  enabled: boolean;
  shareDirectoryTree: boolean;
  shareHistory: boolean;
  createdAtUnix?: number | string;
  updatedAtUnix?: number | string;
}

export interface AgentHostRoomVisitorShareLinkCredential {
  state?: AgentHostRoomVisitorShareLinkState;
  shareToken?: string;
}

export interface AgentHostCreateRoomVisitorShareLinkInput {
  roomId: string;
  shareDirectoryTree: boolean;
  shareHistory: boolean;
}

export interface AgentHostCreateRoomVisitorShareLinkResult {
  link?: AgentHostRoomVisitorShareLinkCredential;
}

export interface AgentHostUpdateRoomVisitorShareLinkInput {
  roomId: string;
  shareDirectoryTree: boolean;
  shareHistory: boolean;
}

export interface AgentHostUpdateRoomVisitorShareLinkResult {
  state?: AgentHostRoomVisitorShareLinkState;
}

export interface AgentHostDisableRoomVisitorShareLinkInput {
  roomId: string;
}

export interface AgentHostDisableRoomVisitorShareLinkResult {
  state?: AgentHostRoomVisitorShareLinkState;
}

export interface AgentHostRevokeRoomShareInviteInput {
  roomId: string;
  inviteId: string;
}

export interface AgentHostRoomCollabStatus {
  roomId: string;
  completedAtUnix: number;
  completedBy: string;
  ownerUnreadCompletion: boolean;
  /** Internal hint: explicit enter should wait for full template bootstrap completion. */
  waitForFinalBootstrap?: boolean;
}
