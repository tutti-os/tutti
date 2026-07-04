import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { createElement, isValidElement, cloneElement, useState } from "react";
import { createPortal } from "react-dom";
import type {
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode
} from "react";
import { afterEach, beforeEach, vi } from "vitest";
import {
  resetAgentHostApiForTests,
  setAgentHostApiForTests
} from "./agentActivityHost";
import type {
  AgentHostInputApi,
  AgentHostRuntimeApi
} from "./host/agentHostApi";
import { installReactRenderLoopConsoleTrap } from "./test/reactRenderLoopConsoleTrap";

const originalConsoleInfo = console.info.bind(console);
console.info = (...args: unknown[]) => {
  if (isSuppressedAgentGuiDiagnostic(args)) {
    return;
  }
  originalConsoleInfo(...args);
};

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = TestResizeObserver;
}

if (!window.ResizeObserver) {
  window.ResizeObserver = TestResizeObserver;
}

if (!document.elementFromPoint) {
  document.elementFromPoint = () => document.body;
}

globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
HTMLCanvasElement.prototype.getContext = () => null;
Element.prototype.scrollIntoView = () => undefined;
Element.prototype.scrollTo = () => undefined;
Object.defineProperty(SVGElement.prototype, "className", {
  configurable: true,
  get() {
    return this.getAttribute("class") ?? "";
  }
});

if (!Element.prototype.getClientRects) {
  Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
}

if (!Element.prototype.getBoundingClientRect) {
  Element.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({})
  });
}

if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({})
  });
}

let restoreReactRenderLoopConsoleTrap: (() => void) | null = null;

vi.mock("react-medium-image-zoom", () => ({
  default: function TestZoom({
    a11yNameButtonZoom,
    a11yNameButtonUnzoom,
    children,
    classDialog,
    onZoomChange,
    ZoomContent
  }: {
    a11yNameButtonZoom?: string;
    a11yNameButtonUnzoom?: string;
    children?: ReactNode;
    classDialog?: string;
    onZoomChange?: (
      value: boolean,
      data: { event: ReactMouseEvent | Event }
    ) => void;
    ZoomContent?: (props: {
      buttonUnzoom: ReactElement;
      img: ReactElement | null;
      modalState?: "LOADED" | "UNLOADING" | "UNLOADED";
    }) => ReactNode;
  }) {
    const [modalState, setModalState] = useState<
      "LOADED" | "UNLOADING" | "UNLOADED"
    >("UNLOADED");
    const isOpen = modalState !== "UNLOADED";
    const labelZoom = a11yNameButtonZoom ?? "Zoom image";
    const labelUnzoom = a11yNameButtonUnzoom ?? "Minimize image";
    const childElement = isValidElement(children)
      ? (children as ReactElement<{
          onClick?: (event: ReactMouseEvent) => void;
        }>)
      : null;
    const visibleChildren =
      childElement !== null
        ? cloneElement(childElement, {
            onClick: (event: ReactMouseEvent) => {
              childElement.props.onClick?.(event);
              onZoomChange?.(true, { event });
              setModalState("LOADED");
            }
          })
        : children;
    const modalImage =
      childElement !== null
        ? cloneElement(childElement as ReactElement<Record<string, unknown>>, {
            "data-rmiz-modal-img": true,
            onTransitionEnd: () => setModalState("UNLOADED")
          })
        : null;
    const buttonUnzoom = createElement(
      "button",
      {
        type: "button",
        "aria-label": labelUnzoom,
        onClick: (event: ReactMouseEvent) => {
          onZoomChange?.(false, { event });
          setModalState("UNLOADING");
        }
      },
      labelUnzoom
    );
    const modal = isOpen
      ? createPortal(
          createElement(
            "span",
            { role: "dialog", className: classDialog, "data-rmiz-modal": "" },
            ZoomContent
              ? ZoomContent({ buttonUnzoom, img: modalImage, modalState })
              : [modalImage, buttonUnzoom]
          ),
          document.body
        )
      : null;

    return createElement(
      "span",
      { "data-rmiz": "" },
      createElement("span", { "data-rmiz-content": "found" }, visibleChildren),
      createElement(
        "span",
        { "data-rmiz-ghost": "" },
        createElement(
          "button",
          {
            type: "button",
            "aria-label": labelZoom,
            "aria-hidden": isOpen ? true : undefined,
            "data-rmiz-btn-zoom": "",
            onClick: (event: ReactMouseEvent) => {
              onZoomChange?.(true, { event });
              setModalState("LOADED");
            }
          },
          labelZoom
        )
      ),
      modal
    );
  }
}));

beforeEach(() => {
  restoreReactRenderLoopConsoleTrap?.();
  restoreReactRenderLoopConsoleTrap = installReactRenderLoopConsoleTrap({
    console
  });
  resetAgentHostApiForTests();
  resetMentionSearchBrowseCacheForTests();
  installTestLocalStorage();
  installTestAgentHostApi();
});

afterEach(() => {
  try {
    cleanup();
    resetAgentHostApiForTests();
    resetMentionSearchBrowseCacheForTests();
  } finally {
    restoreReactRenderLoopConsoleTrap?.();
    restoreReactRenderLoopConsoleTrap = null;
  }
});

function resetMentionSearchBrowseCacheForTests(): void {
  (
    globalThis as typeof globalThis & {
      __tuttiResetAgentMentionSearchBrowseCacheForTests?: () => void;
    }
  ).__tuttiResetAgentMentionSearchBrowseCacheForTests?.();
}

function installTestLocalStorage(): void {
  if (typeof window.localStorage?.clear === "function") {
    return;
  }
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => {
        values.set(key, String(value));
      }
    }
  });
}

function installTestAgentHostApi(): void {
  const windowWithAgentHost = window as unknown as Window & {
    agentHostApi?: AgentHostInputApi | AgentHostRuntimeApi;
  };
  if (
    Object.prototype.hasOwnProperty.call(windowWithAgentHost, "agentHostApi")
  ) {
    setAgentHostApiForTests(windowWithAgentHost.agentHostApi ?? null);
    return;
  }
  let testAgentHostApi: AgentHostInputApi | AgentHostRuntimeApi | null = {
    account: {},
    agentGuiBatch: {},
    clipboard: {},
    debug: {},
    filesystem: {},
    workspace: {}
  } as unknown as AgentHostRuntimeApi;
  Object.defineProperty(windowWithAgentHost, "agentHostApi", {
    configurable: true,
    get() {
      return testAgentHostApi ?? undefined;
    },
    set(value: AgentHostInputApi | AgentHostRuntimeApi | undefined) {
      testAgentHostApi = value ?? null;
      setAgentHostApiForTests(testAgentHostApi);
    }
  });
  setAgentHostApiForTests(testAgentHostApi);
}

function isSuppressedAgentGuiDiagnostic(args: readonly unknown[]): boolean {
  const [prefix] = args;
  return (
    prefix === "[agent-gui] mention-lifecycle" ||
    prefix === "[agent-gui] mention-search"
  );
}
