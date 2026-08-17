import { NativeModules } from "react-native";
import type { AccountSession, DeviceIdentity } from "../services/mobileDomain";
import type { QRCodeScanResult } from "../services/servicePorts";
import type { AppLifecycleNative } from "./appLifecyclePort";
export type { AccountSession, DeviceIdentity } from "../services/mobileDomain";

export interface BrowserLoginCompletion {
  attemptId: string;
  bridgeToken: string;
  deviceId: string;
  transferCode: string;
}

interface MobileSecurityNative {
  addListener(eventName: string): void;
  readonly clientVersion: string;
  readonly clientVersionCode?: number;
  cancelUpdate?(): Promise<void>;
  cancelQRCodeScan(): Promise<void>;
  clearLegacySessionCookie(accountBaseURL: string): Promise<void>;
  clearSession(): Promise<void>;
  installUpdate?(
    apkURL: string,
    sha256: string,
    sizeBytes: number,
    targetVersionCode: number
  ): Promise<void>;
  getOrCreateIdentity(): Promise<DeviceIdentity>;
  loadSession(): Promise<AccountSession | null>;
  saveSession(
    sessionId: string,
    userId: string,
    email: string,
    name: string,
    avatarURL: string
  ): Promise<void>;
  scanQRCode(): Promise<QRCodeScanResult>;
  removeListeners(count: number): void;
  sign(message: string): Promise<string>;
  startBrowserLogin(
    appId: string,
    authLoginURL: string,
    appCallbackURL: string
  ): Promise<BrowserLoginCompletion>;
}

interface MobilePreferencesNative {
  loadThemePreference(): unknown;
  saveThemePreference(preference: string): Promise<void>;
}

interface DeviceLinkNative {
  addListener(eventName: string): void;
  cancelLink(token: number): Promise<void>;
  closeLink(): Promise<void>;
  configureRelay?: (
    endpoint: string,
    queryJSON: string,
    headersJSON: string,
    subprotocol: string
  ) => Promise<void>;
  probeRelay(timeoutMillis: number): Promise<void>;
  connectLink(
    peerDescriptionJSON: string,
    caller: boolean,
    token: number,
    timeoutMillis: number
  ): Promise<string>;
  nextCandidateExchangeAction(
    token: number,
    timeoutMillis: number
  ): Promise<string>;
  notifyRemoteCandidateChange(token: number): Promise<void>;
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
  removeListeners(count: number): void;
  resolveCandidateExchangeAction(
    actionId: number,
    succeeded: boolean,
    retryable: boolean,
    candidatesJSON: string,
    token: number
  ): Promise<number>;
  runLoopbackProbe(timeoutMillis: number): Promise<string>;
  startAgentLive(
    workspaceId: string,
    subscriptionGeneration: number
  ): Promise<void>;
  stopCandidateExchange(token: number): Promise<void>;
  stopAgentLive(): Promise<void>;
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
export const mobilePreferences = requireNativeModule<MobilePreferencesNative>(
  "TuttiMobilePreferences"
);
export const appLifecycle =
  requireNativeModule<AppLifecycleNative>("TuttiAppLifecycle");
export const deviceLink =
  requireNativeModule<DeviceLinkNative>("TuttiDeviceLink");
