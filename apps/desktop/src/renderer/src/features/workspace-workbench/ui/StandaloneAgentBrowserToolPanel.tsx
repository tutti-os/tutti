import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { BrowserNodeI18nKey } from "@tutti-os/browser-node/i18n";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { DesktopBrowserApi } from "@preload/types";
import {
  createStandaloneAgentBrowserToolFeature,
  standaloneAgentBrowserDefaultUrl
} from "./standaloneAgentToolWorkbench.ts";
import { useExternalStoreValue } from "./useExternalStoreValue.ts";
import { StandaloneAgentToolLoadingState } from "./StandaloneAgentToolLoadingState.tsx";

const LazyBrowserNode = lazy(() =>
  import("@tutti-os/browser-node/react").then(({ BrowserNode }) => ({
    default: BrowserNode
  }))
);

const browserNodeLoadFailedI18nKey: BrowserNodeI18nKey = "loadFailed";

export function StandaloneAgentBrowserToolPanel({
  appI18n,
  browserApi,
  hidden,
  loadingLabel
}: {
  appI18n: I18nRuntime<string>;
  browserApi: DesktopBrowserApi;
  hidden: boolean;
  loadingLabel: string;
}): ReactNode {
  const [nodeId] = useState(createStandaloneAgentBrowserNodeId);
  const feature = useMemo(
    () =>
      createStandaloneAgentBrowserToolFeature({
        browserApi,
        i18n: appI18n,
        nodeId
      }),
    [appI18n, browserApi, nodeId]
  );
  const [activationFailed, setActivationFailed] = useState(false);
  const runtimeState = useExternalStoreValue(
    feature.runtimeStore.subscribe,
    () => feature.runtimeStore.getNodeState(nodeId),
    () => feature.runtimeStore.getNodeState(nodeId)
  );

  useEffect(() => {
    const disconnect = feature.connect();
    setActivationFailed(false);
    void browserApi
      .activate({
        navigationPolicy: null,
        nodeId,
        profileId: null,
        sessionMode: "shared",
        url: standaloneAgentBrowserDefaultUrl
      })
      .catch(() => setActivationFailed(true));
    return () => {
      disconnect();
      void browserApi.close({ nodeId }).catch(() => undefined);
    };
  }, [browserApi, feature, nodeId]);

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden"
      data-standalone-agent-browser-surface="true"
    >
      <Suspense
        fallback={<StandaloneAgentToolLoadingState label={loadingLabel} />}
      >
        <LazyBrowserNode
          defaultUrl={standaloneAgentBrowserDefaultUrl}
          feature={feature}
          hidden={hidden}
          nodeId={nodeId}
          syncDefaultUrl
        />
      </Suspense>
      {activationFailed && runtimeState.lifecycle === "cold" ? (
        <div
          className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-secondary)]"
          role="status"
        >
          {feature.i18n.t(browserNodeLoadFailedI18nKey)}
        </div>
      ) : null}
    </div>
  );
}

function createStandaloneAgentBrowserNodeId(): string {
  const instanceId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `browser:standalone-agent-tool:${instanceId}`;
}
