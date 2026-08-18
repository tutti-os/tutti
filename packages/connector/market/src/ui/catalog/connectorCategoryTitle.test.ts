import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { proxy } from "valtio";

import type { ConnectorMarketI18nRuntime } from "../../i18n/connectorMarketI18n.ts";
import type { IConnectorMarketRoot } from "../../services/core/connectorMarketRoot.interface.ts";
import type { ConnectorMarketViewState } from "../../services/view/connectorMarketViewTypes.ts";
import { ConnectorMarketRootProvider } from "../ConnectorMarketServicesContext.tsx";
import { ConnectorCatalog } from "./ConnectorCatalog.tsx";
import { resolveConnectorCategoryTitle } from "./connectorCategoryTitle.ts";

type JsdomModule = {
  JSDOM: new (html: string) => {
    window: Window & typeof globalThis;
  };
};

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as JsdomModule;

const i18n = {
  has: () => true,
  t: (key: string) => key,
  tFirst: (keys: readonly string[]) => keys[0] ?? ""
} as ConnectorMarketI18nRuntime;

test("uses the server-owned category name for the active locale", () => {
  assert.equal(
    resolveConnectorCategoryTitle({
      sectionId: "business-operations",
      displayNameZh: "商业与运营",
      displayNameEn: "Business & Operations",
      locale: "zh-CN",
      i18n
    }),
    "商业与运营"
  );
  assert.equal(
    resolveConnectorCategoryTitle({
      sectionId: "business-operations",
      displayNameZh: "商业与运营",
      displayNameEn: "Business & Operations",
      locale: "en-US",
      i18n
    }),
    "Business & Operations"
  );
});

test("falls back across server languages without changing category id", () => {
  assert.equal(
    resolveConnectorCategoryTitle({
      sectionId: "future-category",
      displayNameEn: "Future Category",
      locale: "zh-HK",
      i18n
    }),
    "Future Category"
  );
});

test("keeps only the released legacy category label fallback", () => {
  assert.equal(
    resolveConnectorCategoryTitle({
      sectionId: "development",
      locale: "en-US",
      i18n
    }),
    "categoryDevelopment"
  );
  assert.equal(
    resolveConnectorCategoryTitle({
      sectionId: "future-category",
      locale: "en-US",
      i18n
    }),
    "categoryUnnamed"
  );
});

test("changes locale presentation without requesting the Market again", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousElement = globalThis.Element;
  const previousActEnvironment = (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  let reactRoot: Root | null = null;

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Node = dom.window.Node;
    globalThis.Element = dom.window.Element;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    let marketRequests = 0;
    const viewState = proxy<ConnectorMarketViewState>({
      availableCount: 0,
      cardsByKey: {},
      catalogError: null,
      dialog: null,
      installedCount: 0,
      refreshing: false,
      sections: [
        {
          id: "developer-tools",
          displayNameZh: "开发者工具",
          displayNameEn: "Developer Tools",
          connectorKeys: [],
          error: false,
          hasMore: false,
          itemCount: 0,
          loading: false
        }
      ],
      status: "ready"
    });
    const connectorRoot = {
      market: {
        async loadMore() {
          marketRequests += 1;
        },
        async reload() {
          marketRequests += 1;
        }
      },
      uiState: {},
      view: { dataStore: viewState }
    } as unknown as IConnectorMarketRoot;
    const container = dom.window.document.getElementById("root");
    assert.ok(container);
    reactRoot = createRoot(container);

    await renderCatalog(reactRoot, connectorRoot, "en-US");
    assert.match(container.textContent ?? "", /Developer Tools/u);

    await renderCatalog(reactRoot, connectorRoot, "zh-CN");
    assert.match(container.textContent ?? "", /开发者工具/u);
    assert.equal(marketRequests, 0);
  } finally {
    if (reactRoot) {
      await act(async () => reactRoot?.unmount());
    }
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.HTMLElement = previousHTMLElement;
    globalThis.Node = previousNode;
    globalThis.Element = previousElement;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

async function renderCatalog(
  reactRoot: Root,
  root: IConnectorMarketRoot,
  locale: string
): Promise<void> {
  await act(async () => {
    reactRoot.render(
      createElement(ConnectorMarketRootProvider, {
        children: createElement(ConnectorCatalog),
        i18n,
        locale,
        root
      })
    );
  });
}
