import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import {
  resetAgentHostApiForTests,
  setAgentHostApiForTests
} from "./agentActivityHost";
import type {
  AgentHostInputApi,
  AgentHostRuntimeApi
} from "./host/agentHostApi";
import { installReactRenderLoopConsoleTrap } from "./test/reactRenderLoopConsoleTrap";

// Vitest 4 runs with NODE_ENV=development; agent test harnesses gate on "test".
process.env.NODE_ENV = "test";

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
