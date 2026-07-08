import { createElement, type ReactNode } from "react";
import type {
  WorkbenchContribution,
  WorkbenchHostActivation,
  WorkbenchHostDockEntry,
  WorkbenchHostExternalStateSource,
  WorkbenchFrame,
  WorkbenchHostLaunchRequest,
  WorkbenchHostLaunchResult,
  WorkbenchHostNodeHeaderContext,
  WorkbenchHostNodeDefinition
} from "@tutti-os/workbench-surface";
import type { BrowserNodeFeature } from "../core/feature.ts";
import {
  BrowserNode,
  BrowserNodeWorkbenchHeader
} from "../react/BrowserNode.tsx";

export interface BrowserNodeOpenUrlActivationPayload {
  title?: string;
  url: string;
}

export interface BrowserNodeExternalState {
  title?: string | null;
  url?: string | null;
}

export interface CreateBrowserNodeDefinitionInput {
  defaultUrl: string;
  dockIcon?: ReactNode;
  feature: BrowserNodeFeature;
  frame?: WorkbenchFrame;
  onNavigated?: (input: { nodeId: string; url: string }) => void;
  renderTrafficLights?: (
    context: WorkbenchHostNodeHeaderContext<BrowserNodeExternalState>
  ) => ReactNode;
  typeId?: string;
}

export interface CreateBrowserDockEntryInput {
  dockIcon?: ReactNode;
  feature: BrowserNodeFeature;
  id?: string;
  order?: number;
  sectionId?: string;
  typeId?: string;
}

export interface CreateBrowserWorkbenchLaunchHandlerInput {
  browserInstancePrefix?: string;
  typeId?: string;
}

export interface CreateBrowserWorkbenchContributionInput {
  contributionId?: string;
  defaultUrl: string;
  dockEntry?: Omit<CreateBrowserDockEntryInput, "feature">;
  externalStateSource?: WorkbenchHostExternalStateSource<
    BrowserNodeExternalState | null,
    unknown
  >;
  feature: BrowserNodeFeature;
  launch?: CreateBrowserWorkbenchLaunchHandlerInput;
  node?: Omit<CreateBrowserNodeDefinitionInput, "defaultUrl" | "feature">;
  typeId?: string;
}

const defaultBrowserNodeFrame: WorkbenchFrame = {
  height: 560,
  width: 920,
  x: 220,
  y: 120
};

export const defaultBrowserNodeTypeId = "browser";

export function createBrowserNodeDefinition({
  defaultUrl,
  feature,
  frame = defaultBrowserNodeFrame,
  onNavigated,
  renderTrafficLights,
  typeId = defaultBrowserNodeTypeId
}: CreateBrowserNodeDefinitionInput): WorkbenchHostNodeDefinition<BrowserNodeExternalState> {
  return {
    frame,
    instance: {
      mode: "multi"
    },
    renderBody: (context) =>
      createElement(BrowserNode, {
        defaultUrl: resolveBrowserNodeInitialUrl({
          activation: context.activation,
          defaultUrl,
          externalNodeState: context.externalNodeState
        }),
        feature,
        hidden: context.node.isMinimized,
        nodeId: context.node.id,
        onFocusRequest: context.isFocused ? undefined : () => context.focus(),
        onNavigated: onNavigated
          ? (url) =>
              onNavigated({
                nodeId: context.node.id,
                url
              })
          : undefined,
        showHeader: false,
        syncDefaultUrl: true
      }),
    renderHeader: (headerContext) =>
      createElement(BrowserNodeWorkbenchHeader, {
        defaultActions: renderTrafficLights
          ? renderTrafficLights(headerContext)
          : headerContext.defaultActions,
        defaultUrl: resolveBrowserNodeInitialUrl({
          activation: headerContext.activation,
          defaultUrl,
          externalNodeState: headerContext.externalNodeState
        }),
        displayMode: headerContext.displayMode,
        dragHandleProps: headerContext.dragHandleProps,
        feature,
        nodeId: headerContext.node.id,
        onCloseRequest: () => {
          void feature.hostApi
            .close({ nodeId: headerContext.node.id })
            .catch(() => undefined);
        },
        onFocusRequest: headerContext.isFocused
          ? undefined
          : () => headerContext.windowActions.focus()
      }),
    title: feature.i18n.t("title"),
    typeId,
    window: {
      closable: true,
      defaultOpen: false,
      minimizedDock: {
        capturePreview: ({ node }) =>
          feature.hostApi.capturePreview?.({ nodeId: node.id }) ?? null,
        kind: "snapshot"
      },
      minimizable: true,
      restoreOnLoad: true
    }
  };
}

export function createBrowserDockEntry(
  input: CreateBrowserDockEntryInput
): WorkbenchHostDockEntry {
  return {
    capturePopupItemPreview: ({ node }) =>
      input.feature.hostApi.capturePreview?.({ nodeId: node.id }) ?? null,
    icon: input.dockIcon ?? null,
    id: input.id ?? defaultBrowserNodeTypeId,
    label: input.feature.i18n.t("dockLabel"),
    launchBehavior: "enabled",
    matchNode: (node) =>
      node.data.typeId === (input.typeId ?? defaultBrowserNodeTypeId),
    order: input.order,
    resolvePopupItem: ({ node }) => {
      const runtime = input.feature.runtimeStore.getNodeState(node.id);
      const title = runtime.title?.trim() || node.title;
      const url = runtime.url?.trim() || node.data.instanceId;
      return {
        revision: `${title}\n${url}`,
        subtitle: url,
        title
      };
    },
    sectionId: input.sectionId,
    typeId: input.typeId ?? defaultBrowserNodeTypeId,
    visibility: "always"
  };
}

export function createBrowserDockIconImage(src: string): ReactNode {
  return createElement("img", {
    alt: "",
    "aria-hidden": "true",
    "data-browser-node-dock-icon": "true",
    draggable: false,
    src
  });
}

export function createBrowserWorkbenchLaunchHandler({
  browserInstancePrefix,
  typeId = defaultBrowserNodeTypeId
}: CreateBrowserWorkbenchLaunchHandlerInput = {}): (
  request: WorkbenchHostLaunchRequest
) => WorkbenchHostLaunchResult | null {
  let nextBrowserInstanceSequence = 1;
  const instancePrefix =
    browserInstancePrefix ?? globalThis.crypto?.randomUUID?.() ?? typeId;

  return (request) => {
    if (request.typeId !== typeId) {
      return null;
    }

    const instanceId = `${typeId}-${instancePrefix}-${nextBrowserInstanceSequence++}`;
    return {
      dockEntryId: request.dockEntryId ?? typeId,
      framePolicy: "cascade",
      instanceId,
      typeId
    };
  };
}

export function createBrowserWorkbenchContribution({
  contributionId,
  defaultUrl,
  dockEntry,
  externalStateSource,
  feature,
  launch,
  node,
  typeId = defaultBrowserNodeTypeId
}: CreateBrowserWorkbenchContributionInput): WorkbenchContribution {
  return {
    dockEntries: [
      createBrowserDockEntry({
        ...dockEntry,
        feature,
        typeId
      })
    ],
    externalStateSource,
    id: contributionId ?? typeId,
    nodes: [
      createBrowserNodeDefinition({
        ...node,
        defaultUrl,
        feature,
        typeId
      })
    ],
    onLaunchRequest: createBrowserWorkbenchLaunchHandler({
      ...launch,
      typeId
    })
  };
}

function resolveBrowserNodeInitialUrl({
  activation,
  defaultUrl,
  externalNodeState
}: {
  activation: WorkbenchHostActivation | null;
  defaultUrl: string;
  externalNodeState?: BrowserNodeExternalState | null;
}): string {
  return (
    readBrowserOpenUrlActivationPayload(activation)?.url ??
    normalizeBrowserNodeInitialUrl(externalNodeState?.url) ??
    defaultUrl
  );
}

function normalizeBrowserNodeInitialUrl(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function readBrowserOpenUrlActivationPayload(
  activation: WorkbenchHostActivation | null
): BrowserNodeOpenUrlActivationPayload | null {
  if (
    activation?.type !== "open-url" ||
    !activation.payload ||
    typeof activation.payload !== "object"
  ) {
    return null;
  }

  const typed =
    activation.payload as Partial<BrowserNodeOpenUrlActivationPayload>;
  return typeof typed.url === "string"
    ? {
        title: typeof typed.title === "string" ? typed.title : undefined,
        url: typed.url
      }
    : null;
}
