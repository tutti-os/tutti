import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type {
  AccountSession,
  DeviceIdentity,
  DevicePairing,
  UserDevice
} from "./mobileDomain";
import type { PairingQRPayload } from "./pairingProtocol";

export interface AccountPort {
  sendEmailCode(email: string): Promise<void>;
  signInWithGitHub(): Promise<AccountSession>;
  verifyEmailCode(email: string, code: string): Promise<AccountSession>;
}

export interface SessionStoragePort {
  clearSession(): Promise<void>;
  clearSessionCookie(accountBaseURL: string): Promise<void>;
  installSessionCookie(
    accountBaseURL: string,
    sessionId: string
  ): Promise<void>;
  loadSession(): Promise<AccountSession | null>;
  saveSession(
    sessionId: string,
    userId: string,
    email: string,
    name: string
  ): Promise<void>;
}

export interface DeviceSecurityPort {
  getOrCreateIdentity(): Promise<DeviceIdentity>;
  scanQRCode(): Promise<string>;
  sign(message: string): Promise<string>;
}

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
}

export interface PairingPort {
  claimPairing(
    sessionId: string,
    payload: PairingQRPayload
  ): Promise<{ challengeId: string; expiresAt: string; state: string }>;
  connectPairedDevice(
    sessionId: string,
    pairingId: string,
    isCurrent: () => boolean
  ): Promise<void>;
  getPairingChallenge(
    sessionId: string,
    challengeId: string
  ): Promise<{ challengeId: string; expiresAt: string; state: string }>;
  listDevices(sessionId: string): Promise<UserDevice[]>;
  listPairings(sessionId: string): Promise<DevicePairing[]>;
  parsePairingQR(raw: string): PairingQRPayload;
  registerCurrentDevice(sessionId: string): Promise<{ userDeviceId: string }>;
}

export interface LifecyclePort {
  subscribe(listener: (active: boolean) => void): () => void;
}

export interface ClockPort {
  now(): number;
  schedule(delayMs: number, callback: () => void): { cancel(): void };
}

export interface MobileServicePorts {
  account: AccountPort;
  clock: ClockPort;
  deviceLink: DeviceLinkPort;
  deviceSecurity: DeviceSecurityPort;
  lifecycle: LifecyclePort;
  pairing: PairingPort;
  sessionStorage: SessionStoragePort;
  createRemoteClient(): TuttidClient;
}
