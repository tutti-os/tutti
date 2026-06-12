import type { ReactNode } from "react";

export type TerminalRuntimeKind = "local" | "vm" | "remote" | (string & {});

export type TerminalSessionStatus =
  | "created"
  | "starting"
  | "running"
  | "detached"
  | "exited"
  | "failed";

export type TerminalWriteEncoding = "utf8" | "binary";

export type TerminalWriteProvenance = "auto" | "user";

export interface TerminalTransportAttachInput {
  afterSeq?: number;
  clientId?: string;
  sessionId: string;
}

export interface TerminalTransportDetachInput {
  clientId?: string;
  sessionId: string;
}

export interface TerminalTransportWriteInput {
  data: string;
  encoding?: TerminalWriteEncoding;
  provenance?: TerminalWriteProvenance;
  sessionId: string;
}

export interface TerminalTransportResizeInput {
  cols: number;
  rows: number;
  sessionId: string;
}

export interface TerminalTransportSnapshotInput {
  sessionId: string;
}

export interface TerminalSnapshot {
  data: string;
  fromSeq?: number;
  toSeq?: number;
  truncated?: boolean;
  updatedAt?: number;
}

export interface TerminalDataEvent {
  data: string;
  seq?: number;
  sessionId: string;
}

export interface TerminalExitEvent {
  code?: number | null;
  reason?: string | null;
  sessionId: string;
  signal?: string | null;
}

export interface TerminalMetadataEvent {
  cwd?: string | null;
  profileId?: string | null;
  resumeSessionId?: string | null;
  runtimeKind?: TerminalRuntimeKind;
  sessionId: string;
  title?: string | null;
}

export interface TerminalStateEvent {
  error?: string | null;
  gapEndSeq?: number | null;
  gapStartSeq?: number | null;
  sessionId: string;
  status: TerminalSessionStatus;
}

export interface TerminalTransport {
  attach(input: TerminalTransportAttachInput): Promise<void>;
  detach(input: TerminalTransportDetachInput): Promise<void>;
  onData(listener: (event: TerminalDataEvent) => void): () => void;
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
  onMetadata?(listener: (event: TerminalMetadataEvent) => void): () => void;
  onState(listener: (event: TerminalStateEvent) => void): () => void;
  resize(input: TerminalTransportResizeInput): Promise<void>;
  snapshot(input: TerminalTransportSnapshotInput): Promise<TerminalSnapshot>;
  write(input: TerminalTransportWriteInput): Promise<void>;
}

export interface TerminalLaunchInput {
  cwd?: string | null;
  initialInput?: string | null;
  profileId?: string | null;
  reason: "dock" | "intent" | "restore";
  workspaceId: string;
}

export interface TerminalSessionDescriptor {
  cwd: string | null;
  profileId: string | null;
  runtimeKind: TerminalRuntimeKind;
  sessionId: string;
  status: TerminalSessionStatus;
  title: string;
}

export interface TerminalLaunchService {
  create(input: TerminalLaunchInput): Promise<TerminalSessionDescriptor>;
  get?(sessionId: string): Promise<TerminalSessionDescriptor | null>;
  terminate(input: { sessionId: string }): Promise<void>;
}

export type TerminalCloseGuardReason =
  | "foreground-process"
  | "not-running"
  | "running"
  | "unknown";

export interface TerminalCloseGuardResult {
  leaderCommand?: string | null;
  reason: TerminalCloseGuardReason;
  requiresConfirmation: boolean;
  status: TerminalSessionStatus;
}

export interface TerminalCloseGuardService {
  check(input: { sessionId: string }): Promise<TerminalCloseGuardResult>;
}

export interface TerminalLinkTarget {
  cwd?: string | null;
  column?: number;
  line?: number;
  path?: string;
  url?: string;
}

export interface TerminalLinkHandler {
  open(target: TerminalLinkTarget): Promise<void> | void;
}

export interface TerminalDropInput {
  cwd: string | null;
  dataTransfer: DataTransfer;
  sessionId: string;
}

export type TerminalDropInputResolver = (
  input: TerminalDropInput
) => Promise<string | null> | string | null;

export type TerminalOutputTransform = (input: {
  data: string;
  sessionId: string;
}) => string | null;

export type TerminalDiagnosticEvent =
  | "attach-complete"
  | "attach-error"
  | "attach-start"
  | "close-confirmed"
  | "close-requested"
  | "dispose"
  | "hydration-complete"
  | "hydration-gap"
  | "hydration-start"
  | "mount"
  | "output-projected"
  | "resize"
  | "snapshot-complete"
  | "snapshot-start"
  | "surface-output-sync"
  | "surface-output-written"
  | "write-error";

export interface TerminalDiagnostics {
  log(
    event: TerminalDiagnosticEvent,
    details?: Record<string, string | number | boolean | null>
  ): void;
}

export interface TerminalNodeExternalState<
  THostMetadata extends Record<string, unknown> = Record<string, unknown>
> {
  createdAt: string | null;
  cwd: string | null;
  endedAt: string | null;
  host: THostMetadata | null;
  lastError: string | null;
  profileId: string | null;
  runtimeKind: TerminalRuntimeKind;
  sessionId: string | null;
  status: TerminalSessionStatus;
  title: string;
  updatedAt: string | null;
}

export interface TerminalNodeLimits {
  maxScrollbackLines: number;
  maxWriteBatchBytes: number;
  snapshotChunkBytes: number;
}

export interface TerminalTheme {
  background?: string;
  cursor?: string;
  foreground?: string;
  selectionBackground?: string;
}

export interface TerminalPreviewSegmentStyle {
  background?: string;
  bold?: boolean;
  color?: string;
  dim?: boolean;
  italic?: boolean;
  overline?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

export interface TerminalPreviewSegment {
  style?: TerminalPreviewSegmentStyle;
  text: string;
}

export interface TerminalPreviewLine {
  segments: readonly TerminalPreviewSegment[];
}

export interface TerminalPreviewSnapshot {
  cols: number;
  cursorX: number;
  cursorY: number;
  lines: readonly TerminalPreviewLine[];
  revision: string;
  rows: number;
  updatedAtUnixMs: number;
}

export interface TerminalPreviewChange {
  nodeId: string;
  sessionId: string;
  snapshot: TerminalPreviewSnapshot | null;
}

export type TerminalPreviewChangeHandler = (
  change: TerminalPreviewChange
) => void;

export type TerminalThemeResolver = (input: {
  runtimeKind: TerminalRuntimeKind;
  sessionId: string | null;
  status: TerminalSessionStatus;
}) => TerminalTheme;

export interface TerminalHeaderAccessoryContext {
  externalState: TerminalNodeExternalState | null;
  sessionId: string | null;
}

export type TerminalHeaderAccessoryRenderer = (
  context: TerminalHeaderAccessoryContext
) => ReactNode;
