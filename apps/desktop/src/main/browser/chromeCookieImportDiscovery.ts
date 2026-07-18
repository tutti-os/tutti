import type {
  BrowserNodeChromeProfileDiscoveryResult,
  BrowserNodeChromeProfileId
} from "@tutti-os/browser-node";
import type { ChromeCookieProfile } from "./chromeCookieImport.ts";

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
