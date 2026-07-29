import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { createBrowserNodeI18nRuntime } from "../i18n/browserNodeI18n.ts";
import type { BrowserNodeI18nRuntime } from "../i18n/browserNodeI18n.ts";
import type { BrowserNodeHostApi } from "./types.ts";
import {
  createBrowserNodeChromeCookieImportFeature,
  type BrowserNodeChromeCookieImportFeature,
  type BrowserNodeChromeImportPromptAdapter
} from "./chromeCookieImport.ts";
import {
  createBrowserNodeRuntimeStore,
  type BrowserNodeRuntimeStore
} from "./runtimeStore.ts";
import {
  createBrowserNodeTabsStore,
  type BrowserNodeTabsStore
} from "./tabsStore.ts";
import {
  resolveBrowserAddressInput,
  resolveBrowserOpenExternalUrl,
  type BrowserAddressInputResolution,
  type BrowserNavigationUrlResolution,
  type BrowserSearchUrlResolver
} from "./url.ts";

export interface BrowserNodeFeature {
  chromeCookieImport: BrowserNodeChromeCookieImportFeature | null;
  hostApi: BrowserNodeHostApi;
  i18n: BrowserNodeI18nRuntime;
  reportDiagnostic?: BrowserNodeDiagnosticReporter;
  resolveAddressInput(rawInput: string): BrowserAddressInputResolution;
  resolveOpenExternalUrl(rawInput: string): BrowserNavigationUrlResolution;
  runtimeStore: BrowserNodeRuntimeStore;
  tabsStore: BrowserNodeTabsStore;
  connect(): () => void;
}

export interface BrowserNodeDiagnosticPayload {
  details?: Record<string, unknown>;
  event: string;
  level?: "debug" | "info" | "warn" | "error";
}

export type BrowserNodeDiagnosticReporter = (
  payload: BrowserNodeDiagnosticPayload
) => void;

export interface CreateBrowserNodeFeatureInput {
  chromeCookieImportPrompt?: BrowserNodeChromeImportPromptAdapter;
  hostApi: BrowserNodeHostApi;
  i18n?: I18nRuntime<string>;
  reportDiagnostic?: BrowserNodeDiagnosticReporter;
  resolveSearchUrl?: BrowserSearchUrlResolver;
  runtimeStore?: BrowserNodeRuntimeStore;
  tabsStore?: BrowserNodeTabsStore;
}

export function createBrowserNodeFeature({
  chromeCookieImportPrompt,
  hostApi,
  i18n,
  reportDiagnostic,
  resolveSearchUrl,
  runtimeStore = createBrowserNodeRuntimeStore(),
  tabsStore = createBrowserNodeTabsStore()
}: CreateBrowserNodeFeatureInput): BrowserNodeFeature {
  let listenerCount = 0;
  let disconnect: (() => void) | null = null;

  const connect = () => {
    listenerCount += 1;
    if (!disconnect) {
      disconnect = hostApi.onEvent((event) => runtimeStore.applyEvent(event));
    }

    return () => {
      listenerCount = Math.max(0, listenerCount - 1);
      if (listenerCount === 0) {
        disconnect?.();
        disconnect = null;
      }
    };
  };

  return {
    chromeCookieImport: createBrowserNodeChromeCookieImportFeature({
      hostApi,
      ...(chromeCookieImportPrompt ? { prompt: chromeCookieImportPrompt } : {})
    }),
    connect,
    hostApi,
    i18n: createBrowserNodeI18nRuntime(i18n),
    reportDiagnostic,
    resolveAddressInput(rawInput) {
      return resolveBrowserAddressInput(rawInput, { resolveSearchUrl });
    },
    resolveOpenExternalUrl(rawInput) {
      return resolveBrowserOpenExternalUrl(rawInput);
    },
    runtimeStore,
    tabsStore
  };
}
