export interface AgentHostTerminalSession {
  id: string;
  roomId?: string | null;
  cwd: string;
  cols: number;
  rows: number;
  state?: AgentHostTerminalSessionState;
  exitCode?: number | null;
  lostReason?: string;
  attachedCount?: number;
  lastSeq?: number;
  createdAt: number;
  updatedAt: number;
}

export type AgentHostTerminalSessionState =
  | "created"
  | "starting"
  | "running"
  | "detached"
  | "exited"
  | "lost"
  | "closed";

export interface AgentHostCreateTerminalInput {
  roomId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  hidden?: boolean;
  initialInput?: string;
  launchCommand?: string[];
  launchEnv?: string[];
}

export interface AgentHostCreateRoomSSHTerminalInput {
  roomId?: string;
  cols?: number;
  rows?: number;
  deviceId?: string;
  deviceLabel?: string;
  preferLocalSSHKey?: boolean;
}

export interface AgentHostCreateVMTerminalInput {
  cwd?: string;
  cols?: number;
  rows?: number;
  initialInput?: string;
  launchCommand?: string[];
  launchEnv?: string[];
}

export interface AgentHostTerminalSnapshotResult {
  session: AgentHostTerminalSession;
  data: string;
  fromSeq: number;
  toSeq: number;
  truncated: boolean;
  updatedAt: number;
}

export type AgentHostTerminalCloseGuardReason =
  | "foreground-process"
  | "not-running"
  | "unknown";

export interface AgentHostTerminalCloseGuardResult {
  requiresConfirmation: boolean;
  reason: AgentHostTerminalCloseGuardReason;
  state: AgentHostTerminalSessionState;
  leaderCommand?: string;
}

export interface AgentHostTerminalSessionEnvelope {
  session: AgentHostTerminalSession;
}

export interface AgentHostTerminalListResult {
  sessions: AgentHostTerminalSession[];
}

export interface AgentHostWriteTerminalInput {
  data: string;
}

export interface AgentHostResizeTerminalInput {
  cols: number;
  rows: number;
}

export interface AgentHostWriteTerminalResult {
  exitCode: number;
}

export interface AgentHostCloseTerminalResult {
  removed: boolean;
}
