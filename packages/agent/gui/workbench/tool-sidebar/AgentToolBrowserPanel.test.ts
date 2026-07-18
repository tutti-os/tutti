import { describe, expect, it } from "vitest";
import type {
  BrowserNodeEvent,
  BrowserNodeHostApi
} from "@tutti-os/browser-node";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { createAgentToolBrowserFeature } from "./AgentToolBrowserPanel.tsx";

describe("AgentToolBrowserPanel", () => {
  it("scopes host events to its browser surface and child tabs", () => {
    let emitEvent = (_event: BrowserNodeEvent): void => undefined;
    const feature = createAgentToolBrowserFeature({
      browserApi: createBrowserApi((listener) => {
        emitEvent = listener;
      }),
      i18n: { t: (key) => key } as I18nRuntime<string>,
      nodeId: "browser:agent-tool:one"
    });
    const disconnect = feature.connect();

    emitEvent(
      createStateEvent("browser:another-window", "https://other.test/")
    );
    expect(
      feature.runtimeStore.getNodeState("browser:agent-tool:one").url
    ).toBeNull();

    emitEvent(
      createStateEvent("browser:agent-tool:one:tab:1", "https://tutti.app/")
    );
    expect(
      feature.runtimeStore.getNodeState("browser:agent-tool:one:tab:1").url
    ).toBe("https://tutti.app/");
    expect(feature.resolveAddressInput("browser tool").url).toBe(
      "https://www.google.com/search?q=browser+tool"
    );

    disconnect();
  });
});

function createBrowserApi(
  subscribe: (listener: (event: BrowserNodeEvent) => void) => void
): BrowserNodeHostApi {
  return {
    activate: async () => undefined,
    close: async () => undefined,
    goBack: async () => undefined,
    goForward: async () => undefined,
    navigate: async () => undefined,
    onEvent(listener) {
      subscribe(listener);
      return () => undefined;
    },
    prepareSession: async () => undefined,
    registerGuest: async () => undefined,
    reload: async () => undefined,
    unregisterGuest: async () => undefined
  };
}

function createStateEvent(nodeId: string, url: string): BrowserNodeEvent {
  return {
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId,
    title: null,
    type: "state",
    url
  };
}
