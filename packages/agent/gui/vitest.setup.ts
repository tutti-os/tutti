import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { setAgentHostApiForTests } from "./agentActivityHost";
import type {
  AgentHostInputApi,
  AgentHostRuntimeApi
} from "./host/agentHostApi";
import { createTestAgentHostApi } from "./vitest.shared.setup";

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

const testLocalStorageValues = new Map<string, string>();
const testLocalStorage: Storage = {
  get length() {
    return testLocalStorageValues.size;
  },
  clear() {
    testLocalStorageValues.clear();
  },
  getItem(key) {
    return testLocalStorageValues.get(key) ?? null;
  },
  key(index) {
    return Array.from(testLocalStorageValues.keys())[index] ?? null;
  },
  removeItem(key) {
    testLocalStorageValues.delete(key);
  },
  setItem(key, value) {
    testLocalStorageValues.set(key, String(value));
  }
};
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: testLocalStorage
});

beforeEach(() => {
  testLocalStorage.clear();
  installTestAgentHostApi();
});

afterEach(() => {
  cleanup();
});

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
  let testAgentHostApi: AgentHostInputApi | AgentHostRuntimeApi | null =
    createTestAgentHostApi();
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
