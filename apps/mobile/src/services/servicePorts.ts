import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { AgentActivityLiveEvent } from "@tutti-os/agent-activity-core";
import type {
  AccountSession,
  DeviceLinkPathScope,
  DevicePairingChallenge,
  DevicePairing,
  DevicePairingPhase,
  UserDevice
} from "./mobileDomain";
import type { PairingQRPayload } from "./pairingProtocol";

export interface AccountPort {
  signInWithBrowser(): Promise<AccountSession>;
}

export interface SessionStoragePort {
  clearSession(): Promise<void>;
  loadSession(): Promise<AccountSession | null>;
  saveSession(
    sessionId: string,
    userId: string,
    email: string,
    name: string,
    avatarURL: string
  ): Promise<void>;
}

export interface LegacySessionCookiePort {
  clear(): Promise<void>;
}

export type QRCodeScanResult =
  | { kind: "manual" }
  | { kind: "scanned"; value: string };

export interface QRCodeScanOperation {
  cancel(): Promise<void>;
  result: Promise<QRCodeScanResult>;
}

export interface QRCodeScannerPort {
  start(): QRCodeScanOperation;
}

export const PAIRING_OPERATION_SUSPENDED = "PAIRING_OPERATION_SUSPENDED";

export interface DeviceLinkPort {
  closeLink(): Promise<void>;
  requestAgentHTTP(
    method: string,
    path: string,
    body: string,
    timeoutMillis: number
  ): Promise<{
    body: string;
    errorCode: string;
    headers: Record<string, string[]>;
    protocolEpoch: number;
    status: number;
  }>;
  subscribeAgentLive(
    workspaceId: string,
    listener: (delivery: AgentLiveDelivery) => void
  ): { close(): void };
}

export type AgentLiveDelivery =
  | {
      kind: "connection";
      status: "connected";
    }
  | {
      expectedRevision?: string;
      kind: "connection";
      reason: string;
      receivedRevision?: string;
      retryable: boolean;
      status: "disconnected";
    }
  | {
      event: AgentActivityLiveEvent;
      kind: "event";
    }
  | {
      kind: "discontinuity";
      reason: string;
      reconcileKeys: readonly AgentLiveReconcileKey[];
    }
  | {
      agentSessionId: string;
      kind: "session_deleted";
    }
  | {
      agentSessionId: string;
      kind: "session_restored";
    }
  | {
      attachment: AgentLiveAttachmentControl;
      kind: "attachment_changed";
    }
  | {
      attachment: AgentLiveAttachmentControl;
      kind: "attachment_caught_up";
    };

export interface AgentLiveAttachmentControl {
  agentSessionId: string;
  attachmentRevision: number;
  bindingId: string;
  callerTurnId?: string;
  canonicalTurnId?: string;
  workspaceId: string;
}

export interface AgentLiveReconcileKey {
  agentSessionId?: string;
  kind: string;
  messageId?: string;
  requestId?: string;
  turnId?: string;
  workspaceId: string;
}

export interface PairingPort {
  claimPairing(
    sessionId: string,
    payload: PairingQRPayload,
    isCurrent: () => boolean
  ): Promise<DevicePairingChallenge>;
  connectPairedDevice(
    sessionId: string,
    pairingId: string,
    isCurrent: () => boolean
  ): Promise<DeviceLinkPathScope>;
  getPairingChallenge(
    sessionId: string,
    challengeId: string
  ): Promise<DevicePairingChallenge>;
  listDevices(sessionId: string): Promise<UserDevice[]>;
  listPairings(sessionId: string): Promise<DevicePairing[]>;
  registerCurrentDevice(sessionId: string): Promise<{ userDeviceId: string }>;
}

export type AppLifecycleState = "background" | "foreground";

export interface AppLifecyclePort {
  subscribe(listener: (state: AppLifecycleState) => void): () => void;
}

export type MobileDiagnosticEvent =
  | {
      name: "application.lifecycle_changed";
      state: AppLifecycleState;
    }
  | {
      name: "device_connection.phase_changed";
      phase: "connected" | "failed" | "idle" | "reconnecting" | "synchronizing";
      expectedRevision?: string;
      reasonCode?: "connection_unavailable" | "protocol_revision_mismatch";
      receivedRevision?: string;
      trigger?:
        | "background_expired"
        | "foreground_resume"
        | "initial_connect"
        | "manual_retry"
        | "transport_lost";
    }
  | {
      elapsedMs: number;
      name: "device_link.stage";
      stage:
        | "direct_attempt_created"
        | "direct_attempt_ready"
        | "direct_credentials_ready"
        | "direct_connected"
        | "direct_first_candidate_published"
        | "direct_remote_candidate_received"
        | "relay_descriptor_ready"
        | "relay_probe_ready";
    }
  | {
      name: "device_pairing.phase_changed";
      phase: DevicePairingPhase;
      source?: "manual" | "scanner";
    }
  | {
      errorCode:
        | "camera_permission_required"
        | "pairing_failed"
        | "scanner_unavailable"
        | null;
      name: "device_pairing.failed";
      stage: "pairing" | "scanner";
    }
  | {
      name: "device_pairing.remote_suspended";
      phase: "claiming" | "waiting";
    };

export interface MobileDiagnosticsPort {
  record(event: MobileDiagnosticEvent): void;
}

export interface ClockPort {
  now(): number;
  schedule(delayMs: number, callback: () => void): { cancel(): void };
}

export interface MobileServicePorts {
  account: AccountPort;
  appLifecycle: AppLifecyclePort;
  clock: ClockPort;
  deviceLink: DeviceLinkPort;
  diagnostics: MobileDiagnosticsPort;
  legacySessionCookie: LegacySessionCookiePort;
  pairing: PairingPort;
  qrCodeScanner: QRCodeScannerPort;
  sessionStorage: SessionStoragePort;
  createRemoteClient(): TuttidClient;
}
