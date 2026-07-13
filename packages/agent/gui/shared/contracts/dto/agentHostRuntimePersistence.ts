export interface AgentHostLeaveRoomResult {
  disconnected: boolean;
  closedTerminals: number;
}

export interface AgentHostLeaveRoomMembershipResult {
  roomId: string;
  left: boolean;
  disconnected: boolean;
  closedTerminals: number;
}

export interface AgentHostRuntimeStatusResult {
  connected: boolean;
  runtimeId?: string;
  activeRoomIds?: string[];
  vmState?: string;
  vmStatus?: string;
  healthDetailCode?: string;
  runtimeConnectionLost?: boolean;
  healthVerified?: boolean;
  healthy?: boolean;
  healthState?: "healthy" | "pending" | "unhealthy" | string;
  detail?: string;
  sandboxSessionState?: "connected" | "reconnecting" | "disconnected";
  panicDetected?: boolean;
  panicExcerpt?: string;
}

export interface AgentHostRuntimeWorkspaceDebugResult {
  vm: {
    connected: boolean;
    state?: string;
    healthState?: string;
    statusMessage?: string;
    imageBootSource?: "new_base" | "active" | "stable" | "base" | string;
    guestAgentRelaySocket?: string;
    sandboxSessionState?:
      | "connected"
      | "reconnecting"
      | "disconnected"
      | "unknown"
      | string;
    diagnosticsStatusMessage?: string;
    panicDetected?: boolean;
    panicExcerpt?: string;
    restartCount: number;
    phases?: AgentHostRuntimeWorkspaceDebugPhase[];
    trace?: AgentHostRuntimeWorkspaceDebugPhase[];
  };
  workspaces: AgentHostRuntimeWorkspaceDebugItem[];
}

export interface AgentHostRuntimeWorkspaceDebugPhase {
  stage: string;
  message?: string;
  status: "started" | "succeeded" | "failed" | string;
  elapsedMs?: number;
  totalElapsedMs?: number;
  attempt?: number;
  imageBootSource?: "new_base" | "active" | "stable" | "base" | string;
  errorLog?: string;
  updatedAt?: string;
}

export interface AgentHostRuntimeWorkspaceDebugItem {
  workspaceId: string;
  roomId?: string;
  roomName?: string;
  state?: string;
  statusMessage?: string;
  mountPoint?: string;
  authorityId?: string;
  sandboxId?: string;
  attached?: boolean;
  attachedAt?: string;
  updatedAt?: string;
  allow?: string[];
  websocket: {
    state:
      | "connected"
      | "reconnecting"
      | "disconnected"
      | "not_started"
      | "unknown"
      | string;
    routeKind?: string;
    subprotocol?: string;
    createdAt?: string;
    lastConnectedAt?: string;
    lastDisconnectedAt?: string;
    reconnectCount: number;
    lastError?: string;
  };
  trace?: AgentHostRuntimeWorkspaceDebugPhase[];
}

export interface AgentHostRuntimeArtifactState {
  status: "idle" | "checking" | "downloading" | "verifying" | "ready" | "error";
  runtimeArtifactVersion: string | null;
  downloadPercent: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  message: string | null;
}

export interface AgentHostRuntimeService {
  port: number;
  previewUrl?: string;
}

export interface AgentHostRuntimeServicesResult {
  connected: boolean;
  roomId?: string;
  statusMessage?: string;
  services: AgentHostRuntimeService[];
}

export interface AgentHostRuntimeResetResult {
  restarted: boolean;
  runtimeId?: string;
  activeRoomIds?: string[];
  reAttachedRoomIds?: string[];
  reAttachFailedRoomIds?: string[];
  vmState?: string;
  vmStatus?: string;
}

export interface AgentHostRuntimePrewarmInput {
  reason?: string;
}

export interface AgentHostRuntimePrewarmResult {
  started: boolean;
  inFlight: boolean;
  reason?: string;
}
