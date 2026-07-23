import { NativeModules } from "react-native";

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

interface MobileSecurityNative {
  clearSession(): Promise<void>;
  getOrCreateIdentity(): Promise<DeviceIdentity>;
  loadSession(): Promise<AccountSession | null>;
  saveSession(
    sessionId: string,
    userId: string,
    email: string,
    name: string
  ): Promise<void>;
  scanQRCode(): Promise<string>;
  sign(message: string): Promise<string>;
}

interface DeviceLinkNative {
  probeEpoch(): Promise<number>;
  runLoopbackProbe(timeoutMillis: number): Promise<string>;
}

function requireNativeModule<T>(name: string): T {
  const module = NativeModules[name] as T | undefined;
  if (!module) {
    throw new Error(`${name} native module is unavailable`);
  }
  return module;
}

export const mobileSecurity = requireNativeModule<MobileSecurityNative>(
  "TuttiMobileSecurity"
);
export const deviceLink =
  requireNativeModule<DeviceLinkNative>("TuttiDeviceLink");
