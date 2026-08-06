import { ObservableService } from "./observableService";

export const MOBILE_UPDATE_SCHEMA_VERSION = "tutti.android.mobile.latest.v1";
export const MOBILE_PACKAGE_NAME = "sh.tutti.mobile";

export type MobileUpdateStatus =
  | "available"
  | "checking"
  | "error"
  | "installing"
  | "idle"
  | "unsupported"
  | "upToDate";

export interface MobileUpdateRelease {
  apkURL: string;
  mandatory: boolean;
  releasedAt: string;
  sha256: string;
  sizeBytes: number | null;
  tag: string;
  versionCode: number;
  versionName: string;
}

export interface MobileUpdateSnapshot {
  checkedAt: string | null;
  currentVersionCode: number;
  currentVersionName: string;
  release: MobileUpdateRelease | null;
  status: MobileUpdateStatus;
}

export interface MobileUpdateInstaller {
  install(apkURL: string, sha256: string): Promise<void>;
}

export interface MobileUpdateServiceOptions {
  currentVersionCode: number;
  currentVersionName: string;
  feedURL: string;
  fetch?: typeof fetch;
  installer?: MobileUpdateInstaller;
  now?: () => Date;
}

export class MobileUpdateService extends ObservableService<MobileUpdateSnapshot> {
  readonly _serviceBrand: undefined;
  private readonly currentVersionCode: number;
  private readonly currentVersionName: string;
  private readonly feedURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly installer: MobileUpdateInstaller | undefined;
  private readonly now: () => Date;
  private snapshot: MobileUpdateSnapshot;
  private checkPromise: Promise<MobileUpdateSnapshot> | null = null;

  constructor(options: MobileUpdateServiceOptions) {
    super();
    this.currentVersionCode = options.currentVersionCode;
    this.currentVersionName = options.currentVersionName;
    this.feedURL = options.feedURL;
    this.fetchImpl = options.fetch ?? fetch;
    this.installer = options.installer;
    this.now = options.now ?? (() => new Date());
    this.snapshot = {
      checkedAt: null,
      currentVersionCode: this.currentVersionCode,
      currentVersionName: this.currentVersionName,
      release: null,
      status: this.installer ? "idle" : "unsupported"
    };
  }

  getSnapshot = (): MobileUpdateSnapshot => this.snapshot;

  async checkForUpdates(): Promise<MobileUpdateSnapshot> {
    if (!this.installer) {
      return this.snapshot;
    }
    if (this.checkPromise) {
      return this.checkPromise;
    }

    this.setSnapshot({ status: "checking", release: null });
    this.checkPromise = this.checkFeed().finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  async installUpdate(): Promise<MobileUpdateSnapshot> {
    const release = this.snapshot.release;
    if (!this.installer || !release) {
      throw new Error("No mobile update is ready to install");
    }

    this.setSnapshot({ status: "installing" });
    try {
      await this.installer.install(release.apkURL, release.sha256);
      return this.snapshot;
    } catch (error) {
      this.setSnapshot({ status: "error" });
      throw error;
    }
  }

  private async checkFeed(): Promise<MobileUpdateSnapshot> {
    try {
      const response = await this.fetchImpl(this.feedURL, {
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
          "User-Agent": "Tutti Android Updater"
        }
      });
      if (!response.ok) {
        throw new Error(
          `Mobile update feed request failed: ${response.status}`
        );
      }

      const release = parseMobileUpdateRelease(await response.json());
      const status =
        release.versionCode > this.currentVersionCode
          ? "available"
          : "upToDate";
      this.setSnapshot({
        checkedAt: this.now().toISOString(),
        release: status === "available" ? release : null,
        status
      });
      return this.snapshot;
    } catch (error) {
      this.setSnapshot({ status: "error" });
      throw error;
    }
  }

  private setSnapshot(
    update: Partial<MobileUpdateSnapshot>
  ): MobileUpdateSnapshot {
    this.snapshot = { ...this.snapshot, ...update };
    this.emitChange();
    return this.snapshot;
  }
}

export function parseMobileUpdateRelease(value: unknown): MobileUpdateRelease {
  if (!isRecord(value)) {
    throw new Error("Mobile update feed must be an object");
  }
  if (value.schemaVersion !== MOBILE_UPDATE_SCHEMA_VERSION) {
    throw new Error("Unsupported mobile update feed schema");
  }
  if (value.packageName !== MOBILE_PACKAGE_NAME) {
    throw new Error("Mobile update package name does not match this app");
  }

  const apkURL = requiredHTTPSURL(value.apkUrl, "apkUrl");
  const releasedAt = requiredString(value.releasedAt, "releasedAt");
  if (!Number.isFinite(Date.parse(releasedAt))) {
    throw new Error("Mobile update releasedAt must be an ISO date");
  }

  const tag = requiredString(value.tag, "tag");
  const versionName = requiredString(value.versionName, "versionName");
  if (tag !== `tutti-mobile-v${versionName}`) {
    throw new Error("Mobile update tag does not match versionName");
  }
  const versionCode = positiveInteger(value.versionCode, "versionCode");
  const sha256 = requiredString(value.sha256, "sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Mobile update sha256 must be a 64-character hex digest");
  }

  const sizeBytes =
    value.sizeBytes === undefined || value.sizeBytes === null
      ? null
      : positiveInteger(value.sizeBytes, "sizeBytes");
  const mandatory = value.mandatory === undefined ? false : value.mandatory;
  if (typeof mandatory !== "boolean") {
    throw new Error("Mobile update mandatory must be a boolean");
  }

  return {
    apkURL,
    mandatory,
    releasedAt,
    sha256,
    sizeBytes,
    tag,
    versionCode,
    versionName
  };
}

function requiredHTTPSURL(value: unknown, key: string): string {
  const candidate = requiredString(value, key);
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:") {
    throw new Error(`Mobile update ${key} must use HTTPS`);
  }
  return parsed.href;
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Mobile update ${key} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Mobile update ${key} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
