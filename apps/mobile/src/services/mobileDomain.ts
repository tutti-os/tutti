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

export interface UserDevice {
  displayName: string;
  platform: string;
  reportedName: string;
  userDeviceId: string;
}
