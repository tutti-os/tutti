import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkbenchLaunchpadItems,
  filterWorkbenchLaunchpadItems,
  paginateWorkbenchLaunchpadItems,
  resolveWorkbenchLaunchpadGrid,
  resolveWorkbenchLaunchpadPreviewIconUrls
} from "./launchpadModel.ts";

test("buildWorkbenchLaunchpadItems keeps two node entries pinned before apps", () => {
  const items = buildWorkbenchLaunchpadItems({
    apps: [
      {
        appId: "calendar",
        label: "Calendar",
        launchEnabled: true
      }
    ],
    nodeDescriptors: ["files", "terminal", "browser"].map((id) => ({
      dockEntryId: id,
      iconUrl: `${id}.svg`,
      id,
      label: id,
      typeId: id
    }))
  });

  assert.deepEqual(
    items.map((item) => item.id),
    ["node:files", "node:terminal", "app:calendar", "node:browser"]
  );
});

test("filterWorkbenchLaunchpadItems normalizes case and surrounding space", () => {
  const items = [{ label: "File Manager" }, { label: "Terminal" }];

  assert.deepEqual(filterWorkbenchLaunchpadItems(items, "  FILE "), [items[0]]);
  assert.notEqual(filterWorkbenchLaunchpadItems(items, ""), items);
});

test("paginateWorkbenchLaunchpadItems clamps invalid pages and page sizes", () => {
  assert.deepEqual(
    paginateWorkbenchLaunchpadItems(["a", "b", "c"], {
      page: 99,
      pageSize: 2
    }),
    { currentPage: 1, pageCount: 2, pageItems: ["c"] }
  );
  assert.deepEqual(
    paginateWorkbenchLaunchpadItems([], { page: Number.NaN, pageSize: 0 }),
    { currentPage: 0, pageCount: 1, pageItems: [] }
  );
});

test("resolveWorkbenchLaunchpadGrid applies the supported grid bounds", () => {
  assert.deepEqual(resolveWorkbenchLaunchpadGrid({ height: 1, width: 1 }), {
    columns: 2,
    pageSize: 2,
    rows: 1
  });
  assert.deepEqual(
    resolveWorkbenchLaunchpadGrid({ height: 10_000, width: 10_000 }),
    { columns: 7, pageSize: 35, rows: 5 }
  );
});

test("resolveWorkbenchLaunchpadPreviewIconUrls deduplicates and fills slots", () => {
  assert.deepEqual(
    resolveWorkbenchLaunchpadPreviewIconUrls({
      agentIcons: ["agent.svg"],
      appIcons: [" app.svg ", "app.svg", null],
      fallbackIconUrl: "fallback.svg",
      nodeIconUrls: ["node.svg"]
    }),
    ["app.svg", "node.svg", "agent.svg", "fallback.svg"]
  );
});
