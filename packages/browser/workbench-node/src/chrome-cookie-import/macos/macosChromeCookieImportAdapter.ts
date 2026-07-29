import type {
  BrowserNodeChromeProfileDiscoveryResult,
  BrowserNodeChromeProfileId,
  BrowserNodeCookieImportFailureStage
} from "../../core/types.ts";
import type {
  BrowserNodeChromeCookiePreparationResult,
  BrowserNodeElectronLogger
} from "../../electron-main/types.ts";
import {
  ChromeCookieImportError,
  discoverChromeCookieProfiles,
  prepareChromeCookies,
  type ChromeCookieImportErrorCode,
  type ChromeCookieProfile,
  type PreparedChromeCookies
} from "./chromeCookieImport.ts";

export interface MacosChromeCookieImportAdapter {
  discoverChromeCookieProfiles(): Promise<BrowserNodeChromeProfileDiscoveryResult>;
  prepareChromeCookieImport(
    profileId: BrowserNodeChromeProfileId,
    signal: AbortSignal
  ): Promise<BrowserNodeChromeCookiePreparationResult>;
}

export interface MacosChromeCookieImportAdapterOptions {
  isEnabled(): boolean;
  logger?: BrowserNodeElectronLogger;
  platform?: NodeJS.Platform;
}

interface MacosChromeCookieImportAdapterDependencies {
  discoverProfiles(): Promise<ChromeCookieProfile[]>;
  prepareCookies(
    profileId: BrowserNodeChromeProfileId,
    signal: AbortSignal
  ): Promise<PreparedChromeCookies>;
}

interface ResolvedMacosChromeCookieImportAdapterOptions extends MacosChromeCookieImportAdapterOptions {
  platform: NodeJS.Platform;
}

export function createMacosChromeCookieImportAdapter(
  options: MacosChromeCookieImportAdapterOptions
): MacosChromeCookieImportAdapter {
  const platform = options.platform ?? process.platform;
  return createMacosChromeCookieImportAdapterWithDependencies(
    { ...options, platform },
    {
      discoverProfiles: () => discoverChromeCookieProfiles({ platform }),
      prepareCookies: (profileId, signal) =>
        prepareChromeCookies(profileId, { platform }, signal)
    }
  );
}

/** @internal Package-local seam for fixture tests; not exported by the public subpath. */
export function createMacosChromeCookieImportAdapterWithDependencies(
  options: ResolvedMacosChromeCookieImportAdapterOptions,
  dependencies: MacosChromeCookieImportAdapterDependencies
): MacosChromeCookieImportAdapter {
  const { platform } = options;
  const discoverChromeCookieProfilesOnce = createChromeCookieProfileDiscovery({
    discoverProfiles: dependencies.discoverProfiles,
    isEnabled: options.isEnabled,
    platform
  });

  return {
    discoverChromeCookieProfiles: discoverChromeCookieProfilesOnce,
    async prepareChromeCookieImport(profileId, signal) {
      if (platform !== "darwin" || !options.isEnabled()) {
        return failedChromeCookiePreparation(
          "profile",
          platform === "darwin" ? "disabled" : "unsupported-platform"
        );
      }
      try {
        const prepared = await dependencies.prepareCookies(profileId, signal);
        if (signal.aborted) {
          return { status: "canceled" };
        }
        return {
          cookies: prepared.cookies,
          skipped: prepared.skipped,
          status: "ready"
        };
      } catch (error) {
        if (signal.aborted) {
          return { status: "canceled" };
        }
        const code =
          error instanceof ChromeCookieImportError
            ? error.code
            : "database_failed";
        const stage = chromeCookieFailureStage(code);
        options.logger?.warn?.("Chrome Cookie import preparation failed", {
          code,
          stage
        });
        return failedChromeCookiePreparation(stage, code);
      }
    }
  };
}

export function createChromeCookieProfileDiscovery(input: {
  discoverProfiles(): Promise<ChromeCookieProfile[]>;
  isEnabled(): boolean;
  platform: NodeJS.Platform;
}): () => Promise<BrowserNodeChromeProfileDiscoveryResult> {
  let discovery: Promise<BrowserNodeChromeProfileDiscoveryResult> | null = null;
  return () => {
    if (input.platform !== "darwin" || !input.isEnabled()) {
      return Promise.resolve({
        reason:
          input.platform === "darwin" ? "disabled" : "unsupported-platform",
        status: "unavailable"
      });
    }
    discovery ??= input
      .discoverProfiles()
      .then(
        (profiles): BrowserNodeChromeProfileDiscoveryResult =>
          profiles.length > 0
            ? {
                profiles: profiles.map((profile) => ({
                  ...profile,
                  id: profile.id as BrowserNodeChromeProfileId
                })),
                status: "available"
              }
            : { reason: "no-profiles", status: "unavailable" }
      )
      .catch(
        (): BrowserNodeChromeProfileDiscoveryResult => ({
          reason: "unavailable",
          status: "unavailable"
        })
      );
    return discovery;
  };
}

function failedChromeCookiePreparation(
  failureStage: BrowserNodeCookieImportFailureStage,
  failureCode: string
): BrowserNodeChromeCookiePreparationResult {
  return { failureCode, failureStage, status: "failed" };
}

function chromeCookieFailureStage(
  code: ChromeCookieImportErrorCode
): BrowserNodeCookieImportFailureStage {
  switch (code) {
    case "unsupported_platform":
    case "chrome_unavailable":
    case "profile_not_found":
    case "profile_invalid":
      return "profile";
    case "snapshot_failed":
      return "snapshot";
    case "keychain_denied":
    case "keychain_timeout":
    case "keychain_failed":
      return "keychain";
    case "schema_unsupported":
    case "database_failed":
      return "database";
    case "cipher_incompatible":
      return "decrypt";
    case "integrity_failed":
      return "integrity";
  }
}
