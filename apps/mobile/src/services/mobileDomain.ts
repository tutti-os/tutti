export interface AccountSession {
  email: string;
  name: string;
  sessionId: string;
  userId: string;
}

export interface DeviceIdentity {
  arch: string;
  deviceId: string;
  deviceName: string;
  publicKey: string;
}

export interface DevicePairing {
  confirmedAt?: string;
  controllerUserDeviceId: string;
  pairingId: string;
  revision: string;
  state: string;
  targetUserDeviceId: string;
}

export type DevicePairingPhase =
  | "idle"
  | "scanning"
  | "claiming"
  | "waiting"
  | "confirmed";

export type DevicePairingChallengeState =
  | "awaiting_claim"
  | "awaiting_confirmation"
  | "confirmed";

export interface DevicePairingChallenge {
  challengeId: string;
  expiresAt: string;
  state: DevicePairingChallengeState;
}

export interface UserDevice {
  displayName: string;
  platform: string;
  reportedName: string;
  userDeviceId: string;
}
