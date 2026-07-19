import type { BrowserNodeFeature } from "../core/feature.ts";
import type { BrowserNodeChromeImportState } from "../core/chromeCookieImport.ts";
import type {
  BrowserNodeChromeProfile,
  BrowserNodeChromeProfileId,
  BrowserNodeCookieImportResult,
  BrowserNodeSessionMode
} from "../core/types.ts";

export interface BrowserNodeCookieImportFeedback {
  message: string;
  tone: "error" | "success" | "warning";
}

export function initialChromeProfileSelection(
  profiles: readonly BrowserNodeChromeProfile[]
): BrowserNodeChromeProfileId | null {
  return profiles.length === 1 ? profiles[0]!.id : null;
}

export function isChromeCookieImportEligible(input: {
  sessionMode: BrowserNodeSessionMode;
  sessionPartition: string | null;
}): boolean {
  return input.sessionMode !== "incognito" && input.sessionPartition === null;
}

export function chromeProfileAvatarDataUrl(
  profile: BrowserNodeChromeProfile
): string | null {
  return profile.avatarDataUrl &&
    /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(
      profile.avatarDataUrl
    )
    ? profile.avatarDataUrl
    : null;
}

export function browserNodeCookieImportFeedback(
  feature: Pick<BrowserNodeFeature, "i18n">,
  result: BrowserNodeCookieImportResult
): BrowserNodeCookieImportFeedback | null {
  if (result.status === "canceled") {
    return null;
  }
  if (result.status === "failed") {
    return {
      message:
        result.failureStage === "snapshot"
          ? feature.i18n.t("chromeImport.snapshotFailed")
          : result.failureStage === "keychain"
            ? feature.i18n.t("chromeImport.keychainFailed")
            : feature.i18n.t("settings.importFailed"),
      tone: "error"
    };
  }
  if (result.imported === 0) {
    return {
      message: feature.i18n.t("settings.importZeroResult", {
        failed: result.failed,
        skipped: result.skipped
      }),
      tone: "warning"
    };
  }
  if (result.partial) {
    return {
      message: feature.i18n.t("settings.importPartialResult", {
        failed: result.failed,
        imported: result.imported,
        skipped: result.skipped
      }),
      tone: "warning"
    };
  }
  return {
    message: feature.i18n.t("settings.importResult", {
      failed: result.failed,
      imported: result.imported,
      skipped: result.skipped
    }),
    tone: "success"
  };
}

export function shouldShowChromeImportPrompt(input: {
  dismissed: boolean;
  hasPromptAdapter: boolean;
  state: BrowserNodeChromeImportState;
}): boolean {
  return (
    input.hasPromptAdapter &&
    !input.dismissed &&
    input.state.status === "available" &&
    input.state.profiles.length > 0
  );
}
