import { NativeModules } from "react-native";

export interface AccountSession {
  email: string;
  name: string;
  sessionId: string;
  userId: string;
}

export interface BrowserLoginCompletion {
  attemptId: string;
  bridgeToken: string;
  deviceId: string;
  transferCode: string;
}

export interface DeviceIdentity {
  arch: string;
  deviceId: string;
  deviceName: string;
  publicKey: string;
}

interface MobileSecurityNative {
  clearSession(): Promise<void>;
  clearSessionCookie(accountBaseURL: string): Promise<void>;
  getOrCreateIdentity(): Promise<DeviceIdentity>;
  loadSession(): Promise<AccountSession | null>;
  installSessionCookie(
    accountBaseURL: string,
    sessionId: string
  ): Promise<void>;
  saveSession(
    sessionId: string,
    userId: string,
    email: string,
    name: string
  ): Promise<void>;
  scanQRCode(): Promise<string>;
  sign(message: string): Promise<string>;
  startBrowserLogin(
    appId: string,
    authLoginURL: string,
    appCallbackURL: string
  ): Promise<BrowserLoginCompletion>;
}

interface DeviceLinkNative {
  closeLink(): Promise<void>;
  connectLink(
    peerDescriptionJSON: string,
    caller: boolean,
    token: number,
    timeoutMillis: number
  ): Promise<string>;
  prepareLink(
    stunEndpointsJSON: string,
    timeoutMillis: number
  ): Promise<{
    descriptionJSON: string;
    token: number;
  }>;
  probeEpoch(): Promise<number>;
  protocolEpoch(): Promise<number>;
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
