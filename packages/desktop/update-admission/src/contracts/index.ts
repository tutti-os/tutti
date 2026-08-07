export const desktopUpdatePolicies = ["off", "prompt", "auto"] as const;
export type DesktopUpdatePolicy = (typeof desktopUpdatePolicies)[number];

export const desktopUpdateChannels = ["stable", "rc"] as const;
export type DesktopUpdateChannel = (typeof desktopUpdateChannels)[number];

export const desktopUpdateStatuses = [
  "disabled",
  "unsupported",
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "up_to_date",
  "error"
] as const;
export type DesktopUpdateStatus = (typeof desktopUpdateStatuses)[number];

export interface ConfigureDesktopUpdatesInput {
  channel: DesktopUpdateChannel;
  policy: DesktopUpdatePolicy;
}

export interface DesktopUpdateState {
  channel: DesktopUpdateChannel;
  checkedAt: string | null;
  currentVersion: string;
  downloadedBytes: number | null;
  downloadPercent: number | null;
  latestVersion: string | null;
  message: string | null;
  policy: DesktopUpdatePolicy;
  releaseDate: string | null;
  releaseName: string | null;
  releaseNotesUrl: string | null;
  status: DesktopUpdateStatus;
  totalBytes: number | null;
}

export const desktopProducts = ["tsh-desktop", "tutti-desktop"] as const;
export type DesktopProduct = (typeof desktopProducts)[number];
export type DesktopPlatform = "macos" | "windows" | "linux";
export type DesktopArchitecture = "arm64" | "x64";

export interface MinimumVersionCheckRequest<
  TProduct extends DesktopProduct = DesktopProduct
> {
  product: TProduct;
  platform: DesktopPlatform;
  architecture: DesktopArchitecture;
  currentVersion: string;
}

export type MinimumVersionDecision =
  | "allowed"
  | "upgradeRequired"
  | "notApplicable";

interface MinimumVersionPolicyResponseBase {
  policyRevision: string;
}

export type MinimumVersionPolicyResponse =
  | (MinimumVersionPolicyResponseBase & {
      channel: "unmanaged";
      decision: "notApplicable";
      reason: "unmanagedPrerelease";
      minimumVersion?: never;
    })
  | (MinimumVersionPolicyResponseBase & {
      channel: DesktopUpdateChannel;
      decision: "notApplicable";
      reason: "unsupportedRelease";
      minimumVersion?: never;
    })
  | (MinimumVersionPolicyResponseBase & {
      channel: DesktopUpdateChannel;
      decision: "allowed";
      reason: "minimumNotConfigured";
      minimumVersion?: never;
    })
  | (MinimumVersionPolicyResponseBase & {
      channel: DesktopUpdateChannel;
      decision: "allowed";
      reason: "meetsMinimum";
      minimumVersion: string;
    })
  | (MinimumVersionPolicyResponseBase & {
      channel: DesktopUpdateChannel;
      decision: "upgradeRequired";
      reason: "belowMinimum";
      minimumVersion: string;
    });

export type MinimumVersionCheckResponse = MinimumVersionPolicyResponse & {
  featureAvailability?: DesktopFeatureAvailability;
};

export type MinimumVersionCheckResult<
  TProduct extends DesktopProduct = DesktopProduct
> = MinimumVersionCheckRequest<TProduct> & MinimumVersionPolicyResponse;

export type UpgradeRequiredMinimumVersionCheckResult<
  TProduct extends DesktopProduct = DesktopProduct
> = MinimumVersionCheckRequest<TProduct> &
  Extract<MinimumVersionPolicyResponse, { decision: "upgradeRequired" }>;

export interface DesktopFeatureAvailability {
  keys: readonly string[];
}

export type DesktopFeatureAvailabilitySource = "remote" | "cache" | "empty";

export interface DesktopFeatureAvailabilitySnapshot<
  TProduct extends DesktopProduct = DesktopProduct
> extends MinimumVersionCheckRequest<TProduct> {
  policyRevision: string | null;
  fetchedAt: string | null;
  source: DesktopFeatureAvailabilitySource;
  keys: readonly string[];
}

export interface DesktopFeatureAvailabilityRuntime<
  TProduct extends DesktopProduct = DesktopProduct
> {
  getSnapshot(): DesktopFeatureAvailabilitySnapshot<TProduct>;
  isSupported(key: string): boolean;
  subscribe(
    listener: (snapshot: DesktopFeatureAvailabilitySnapshot<TProduct>) => void
  ): () => void;
}

export type DesktopUpdateAdmissionPolicySnapshot =
  | {
      status: "checking";
      response?: never;
      failure?: never;
      reason?: never;
    }
  | {
      status: "resolved";
      response: MinimumVersionPolicyResponse;
      failure?: never;
      reason?: never;
    }
  | {
      status: "failedOpen";
      response?: never;
      failure: {
        kind: "timeout" | "transport" | "invalidResponse";
      };
      reason?: never;
    }
  | {
      status: "skipped";
      response?: never;
      failure?: never;
      reason: "checksDisabled";
    };

export interface DesktopUpdateAdmissionSnapshot<
  TProduct extends DesktopProduct = DesktopProduct
> {
  identity: MinimumVersionCheckRequest<TProduct>;
  policy: DesktopUpdateAdmissionPolicySnapshot;
  featureAvailability: {
    keys: readonly string[];
    source: DesktopFeatureAvailabilitySource;
    policyRevision: string | null;
    fetchedAt: string | null;
  };
  lastAttemptAt: string | null;
  nextForegroundCheckAt: string | null;
}

export interface DesktopUpdateAdmissionRefreshResult<
  TProduct extends DesktopProduct = DesktopProduct
> {
  performed: boolean;
  skipReason?: "checksDisabled" | "throttled" | "requestInFlight";
  snapshot: DesktopUpdateAdmissionSnapshot<TProduct>;
}

export interface DesktopUpdateAdmissionBackend<
  TProduct extends DesktopProduct = DesktopProduct
> {
  getStartupSnapshot(
    signal: AbortSignal
  ): Promise<DesktopUpdateAdmissionSnapshot<TProduct>>;
  refresh(
    trigger: "foreground" | "retry",
    signal: AbortSignal
  ): Promise<DesktopUpdateAdmissionRefreshResult<TProduct>>;
}

export interface DesktopFeatureAvailabilityApi {
  getSnapshot(): Promise<DesktopFeatureAvailabilitySnapshot>;
  isSupported(key: string): Promise<boolean>;
  onChanged(
    listener: (snapshot: DesktopFeatureAvailabilitySnapshot) => void
  ): () => void;
}

export type MinimumVersionUpgradePhase =
  | "blocked"
  | "checking"
  | "ready"
  | "downloading"
  | "downloaded"
  | "simulationComplete"
  | "error"
  | "released";

export type MinimumVersionUpgradeError =
  | "releaseBelowMinimum"
  | "updateUnavailable"
  | "policyCheckFailed"
  | "installFailed"
  | "updateFailed";

export interface MinimumVersionUpgradeState<
  TProduct extends DesktopProduct = DesktopProduct
> {
  phase: MinimumVersionUpgradePhase;
  check: UpgradeRequiredMinimumVersionCheckResult<TProduct>;
  update: DesktopUpdateState;
  message: MinimumVersionUpgradeError | null;
}

export interface MandatoryDesktopUpdateTarget {
  channel: DesktopUpdateChannel;
  minimumVersion: string;
  policyRevision: string;
}

export interface MandatoryDesktopUpdateSession {
  retarget(input: MandatoryDesktopUpdateTarget): void;
  prepare(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  release(options?: { restoreNormal?: boolean }): Promise<void>;
}

export interface MinimumVersionAppUpdateService {
  getState(): DesktopUpdateState;
  acquireMandatorySession(
    input: MandatoryDesktopUpdateTarget
  ): Promise<MandatoryDesktopUpdateSession>;
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
}

export interface DesktopUpdateAdmissionRuntime {
  checksEnabled: boolean;
  currentVersion: string;
  development: boolean;
}

export { desktopFeatureAvailabilityIpcChannels } from "./featureAvailabilityIpc.ts";
export { desktopUpdateAdmissionIpcChannels } from "./updateAdmissionIpc.ts";

export interface DesktopMinimumVersionApi {
  getState(): Promise<MinimumVersionUpgradeState | null>;
  start(): Promise<MinimumVersionUpgradeState | null>;
  retry(): Promise<MinimumVersionUpgradeState | null>;
  later(): Promise<void>;
  openManualDownload(): Promise<void>;
  exit(): Promise<void>;
  restart(): Promise<void>;
  onState(listener: (state: MinimumVersionUpgradeState) => void): () => void;
}
