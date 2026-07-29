import { useCallback, useEffect, useMemo, useRef } from "react";
import { useExternalStoreSnapshot } from "@tutti-os/ui-react-hooks";
import {
  acquireBrowserNodeWebviewController,
  type BrowserNodeWebviewContextMenuPoint,
  type BrowserNodeWebviewControllerState
} from "../core/webviewController.ts";
import type { BrowserNodeFeature } from "../core/feature.ts";
import type {
  BrowserNodeAutomationTargetMetadata,
  BrowserNodeLifecycle,
  BrowserNodeNavigationPolicy,
  BrowserNodeSessionMode
} from "../core/types.ts";
import type { BrowserNodeWebviewTag } from "./webviewTag.ts";

export function useBrowserNodeWebview({
  automationTarget,
  feature,
  initialUrl,
  lifecycle,
  navigationPolicy,
  nodeId,
  onGuestInteraction,
  profileId,
  sessionMode,
  sessionPartition
}: {
  automationTarget?: BrowserNodeAutomationTargetMetadata | null;
  feature: BrowserNodeFeature;
  initialUrl: string;
  lifecycle: BrowserNodeLifecycle;
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  onGuestInteraction?: () => void;
  profileId: string | null;
  sessionMode: BrowserNodeSessionMode;
  sessionPartition?: string | null;
}): {
  devToolsContextMenu: BrowserNodeWebviewContextMenuPoint | null;
  dismissDevToolsContextMenu: () => void;
  openDevToolsFromContextMenu: () => Promise<void>;
  shouldRenderWebview: boolean;
  setWebviewRef: (element: BrowserNodeWebviewTag | null) => void;
  webviewKey: string;
  webviewPartition: string;
  webviewSrc: string;
} {
  const onGuestInteractionRef = useRef(onGuestInteraction);
  onGuestInteractionRef.current = onGuestInteraction;
  const stableOnGuestInteraction = useCallback(() => {
    onGuestInteractionRef.current?.();
  }, []);

  const controller = useMemo(
    () =>
      acquireBrowserNodeWebviewController({
        automationTarget,
        feature,
        initialUrl,
        lifecycle,
        navigationPolicy,
        nodeId,
        onGuestInteraction: stableOnGuestInteraction,
        profileId,
        sessionMode,
        sessionPartition
      }),
    [
      feature,
      automationTarget,
      initialUrl,
      lifecycle,
      navigationPolicy,
      nodeId,
      stableOnGuestInteraction,
      profileId,
      sessionMode,
      sessionPartition
    ]
  );

  useEffect(() => {
    controller.retain();
    return () => {
      controller.release();
    };
  }, [controller]);

  useEffect(() => {
    controller.sync();
  }, [
    controller,
    automationTarget,
    initialUrl,
    lifecycle,
    navigationPolicy,
    nodeId,
    profileId,
    sessionMode,
    sessionPartition
  ]);
  const state = useExternalStoreSnapshot<BrowserNodeWebviewControllerState>({
    getSnapshot() {
      return controller.getState();
    },
    subscribe(listener) {
      return controller.subscribe(listener);
    }
  });

  const setWebviewRef = useCallback(
    (element: BrowserNodeWebviewTag | null) => {
      controller.setWebview(element);
    },
    [controller]
  );
  const dismissDevToolsContextMenu = useCallback(() => {
    controller.dismissDevToolsContextMenu();
  }, [controller]);
  const openDevToolsFromContextMenu = useCallback(() => {
    return controller.openDevToolsFromContextMenu();
  }, [controller]);

  return {
    devToolsContextMenu: state.devToolsContextMenu,
    dismissDevToolsContextMenu,
    openDevToolsFromContextMenu,
    shouldRenderWebview: state.shouldRenderWebview,
    setWebviewRef,
    webviewKey: state.webviewKey,
    webviewPartition: state.webviewPartition,
    webviewSrc: state.webviewSrc
  };
}
