import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { createElement, isValidElement, cloneElement, useState } from "react";
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
    ZoomContent
  }: {
    a11yNameButtonZoom?: string;
    a11yNameButtonUnzoom?: string;
    children?: ReactNode;
    classDialog?: string;
    ZoomContent?: (props: {
      buttonUnzoom: ReactElement;
      img: ReactElement | null;
    }) => ReactNode;
  }) {
    const [isOpen, setIsOpen] = useState(false);
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
              setIsOpen(true);
            }
          })
        : children;
    const modalImage =
      childElement !== null
        ? cloneElement(childElement as ReactElement<Record<string, unknown>>, {
            "data-rmiz-modal-img": true
          })
        : null;
    const buttonUnzoom = createElement(
      "button",
      {
        type: "button",
        "aria-label": labelUnzoom,
        onClick: () => setIsOpen(false)
      },
      labelUnzoom
    );

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
            onClick: () => setIsOpen(true)
          },
          labelZoom
        )
      ),
      isOpen
        ? createElement(
            "span",
            { role: "dialog", className: classDialog, "data-rmiz-modal": "" },
            ZoomContent
              ? ZoomContent({ buttonUnzoom, img: modalImage })
              : [modalImage, buttonUnzoom]
          )
        : null
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
