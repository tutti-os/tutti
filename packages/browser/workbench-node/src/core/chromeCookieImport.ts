import type {
  BrowserNodeChromeProfileDiscoveryResult,
  BrowserNodeChromeProfileId,
  BrowserNodeCookieImportResult,
  BrowserNodeHostApi
} from "./types.ts";

export interface BrowserNodeChromeImportPromptAdapter {
  dismiss(): void;
  isDismissed(): boolean;
  subscribe(listener: () => void): () => void;
}

export type BrowserNodeChromeImportState =
  | { status: "idle" | "loading" }
  | BrowserNodeChromeProfileDiscoveryResult;

export interface BrowserNodeChromeCookieImportFeature {
  readonly prompt: BrowserNodeChromeImportPromptAdapter | null;
  cancelImport(operationId: string): Promise<void>;
  discover(): Promise<BrowserNodeChromeProfileDiscoveryResult>;
  getSnapshot(): BrowserNodeChromeImportState;
  importProfile(input: {
    nodeId: string;
    operationId: string;
    profileId: BrowserNodeChromeProfileId;
  }): Promise<BrowserNodeCookieImportResult>;
  subscribe(listener: () => void): () => void;
}

export function createBrowserNodeChromeCookieImportFeature(input: {
  hostApi: Pick<
    BrowserNodeHostApi,
    | "cancelChromeCookieImport"
    | "discoverChromeCookieProfiles"
    | "importChromeCookies"
  >;
  prompt?: BrowserNodeChromeImportPromptAdapter;
}): BrowserNodeChromeCookieImportFeature | null {
  const discoverProfiles = input.hostApi.discoverChromeCookieProfiles;
  const importCookies = input.hostApi.importChromeCookies;
  const cancelImport = input.hostApi.cancelChromeCookieImport;
  if (!discoverProfiles || !importCookies || !cancelImport) {
    return null;
  }

  const listeners = new Set<() => void>();
  let state: BrowserNodeChromeImportState = { status: "idle" };
  let discovery: Promise<BrowserNodeChromeProfileDiscoveryResult> | null = null;
  const publish = (next: BrowserNodeChromeImportState): void => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    cancelImport(operationId) {
      return cancelImport({ operationId });
    },
    prompt: input.prompt ?? null,
    discover() {
      if (discovery) {
        return discovery;
      }
      publish({ status: "loading" });
      discovery = Promise.resolve(discoverProfiles())
        .catch(
          (): BrowserNodeChromeProfileDiscoveryResult => ({
            reason: "unavailable",
            status: "unavailable"
          })
        )
        .then((result) => {
          publish(result);
          return result;
        });
      return discovery;
    },
    getSnapshot() {
      return state;
    },
    async importProfile({ nodeId, operationId, profileId }) {
      const result = await importCookies({ nodeId, operationId, profileId });
      if (result.imported > 0) {
        input.prompt?.dismiss();
      }
      return result;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
