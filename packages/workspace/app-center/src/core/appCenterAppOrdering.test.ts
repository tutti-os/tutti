import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppCenterViewModel } from "../contracts/viewModel.ts";
import {
  isCommunityRecommendedApp,
  sortCommunityApps,
  sortMyAppsByCreatedDesc,
  sortRecommendedApps,
  sortRecommendedAppsForAllTab
} from "./appCenterAppOrdering.ts";

describe("sortMyAppsByCreatedDesc", () => {
  it("orders newer apps first and uses name then id as stable tie breakers", () => {
    const apps = [
      createApp({ createdAtUnixMs: 10, id: "zeta", name: "Zeta" }),
      createApp({ createdAtUnixMs: 30, id: "middle", name: "Middle" }),
      createApp({ createdAtUnixMs: 30, id: "alpha-b", name: "Alpha" }),
      createApp({ createdAtUnixMs: 30, id: "alpha-a", name: "Alpha" }),
      createApp({ createdAtUnixMs: null, id: "legacy", name: "Legacy" })
    ];

    assert.deepEqual(
      sortMyAppsByCreatedDesc(apps).map((app) => app.id),
      ["alpha-a", "alpha-b", "middle", "zeta", "legacy"]
    );
  });
});

describe("sortRecommendedApps", () => {
  it("orders recommended apps by the configured display list", () => {
    const apps = [
      createApp({
        id: "automation",
        name: "Automation",
        sourceKind: "bundled"
      }),
      createApp({
        id: "ai-slide",
        name: "AI PPT",
        sourceKind: "bundled",
        tags: ["coming-soon"]
      }),
      createApp({
        id: "ai-doc",
        name: "AI Document",
        sourceKind: "bundled"
      }),
      createApp({
        id: "vibe-design",
        name: "Vibe Design",
        sourceKind: "bundled"
      }),
      createApp({
        id: "ai-media-canvas",
        name: "AI Media Canvas",
        sourceKind: "bundled"
      }),
      createApp({
        id: "daily-product-radar",
        name: "Daily Product Radar",
        sourceKind: "bundled"
      })
    ];

    assert.deepEqual(
      sortRecommendedApps(apps).map((app) => app.id),
      [
        "ai-slide",
        "ai-doc",
        "ai-media-canvas",
        "vibe-design",
        "automation",
        "daily-product-radar"
      ]
    );
  });

  it("places installed recommended apps before uninstalled apps in the same section", () => {
    const apps = [
      createApp({
        id: "ai-slide",
        name: "AI PPT",
        sourceKind: "bundled",
        tags: ["coming-soon"]
      }),
      createApp({
        id: "ai-doc",
        installed: true,
        name: "AI Document",
        sourceKind: "bundled"
      }),
      createApp({
        id: "ai-sheet",
        name: "AI Sheet",
        sourceKind: "bundled",
        tags: ["coming-soon"]
      })
    ];

    assert.deepEqual(
      sortRecommendedApps(apps).map((app) => app.id),
      ["ai-doc", "ai-slide", "ai-sheet"]
    );
  });

  it("places unlisted apps after configured apps and keeps coming soon after ready", () => {
    const apps = [
      createApp({
        id: "unknown-soon",
        name: "Unknown soon",
        sourceKind: "bundled",
        statusLabelKey: "status.comingSoon"
      }),
      createApp({
        id: "unknown-ready",
        name: "Unknown ready",
        sourceKind: "bundled"
      }),
      createApp({ id: "automation", name: "Automation", sourceKind: "bundled" })
    ];

    assert.deepEqual(
      sortRecommendedApps(apps).map((app) => app.id),
      ["automation", "unknown-ready", "unknown-soon"]
    );
  });
});

describe("sortRecommendedAppsForAllTab", () => {
  it("uses the same configured display order as category tabs", () => {
    const apps = [
      createApp({
        id: "group-chat",
        name: "Group Chat",
        sourceKind: "bundled"
      }),
      createApp({
        id: "open-cut",
        name: "Open Cut",
        sourceKind: "bundled",
        tags: ["coming-soon"]
      }),
      createApp({
        id: "ai-media-canvas",
        name: "AI Media Canvas",
        sourceKind: "bundled"
      })
    ];

    assert.deepEqual(
      sortRecommendedAppsForAllTab(apps).map((app) => app.id),
      ["ai-media-canvas", "group-chat", "open-cut"]
    );
  });

  it("orders radar aliases with other installable apps before coming soon apps", () => {
    const apps = [
      createApp({
        id: "ai-slide",
        name: "AI PPT",
        sourceKind: "bundled",
        tags: ["coming-soon"]
      }),
      createApp({
        id: "daily-tech-radar",
        name: "每日产品雷达",
        sourceKind: "bundled"
      }),
      createApp({ id: "automation", name: "Automation", sourceKind: "bundled" })
    ];

    assert.deepEqual(
      sortRecommendedAppsForAllTab(apps).map((app) => app.id),
      ["ai-slide", "automation", "daily-tech-radar"]
    );
  });
});

describe("sortCommunityApps", () => {
  it("orders community apps by the configured community display list", () => {
    const apps = [
      createApp({
        id: "product-competition",
        name: "Competitive Analysis",
        sourceKind: "bundled"
      }),
      createApp({
        id: "draw-topic-app",
        name: "抽张主意",
        sourceKind: "bundled"
      }),
      createApp({
        id: "daily-tech-radar",
        name: "Daily Product Radar",
        sourceKind: "bundled"
      }),
      createApp({
        id: "group-chat",
        name: "Group Chat",
        sourceKind: "bundled"
      }),
      createApp({
        id: "design-review",
        name: "Design Review",
        sourceKind: "bundled"
      }),
      createApp({
        id: "omni-catcher",
        name: "Omni Catcher",
        sourceKind: "bundled"
      })
    ];

    assert.deepEqual(
      sortCommunityApps(apps).map((app) => app.id),
      [
        "group-chat",
        "design-review",
        "product-competition",
        "daily-tech-radar",
        "draw-topic-app",
        "omni-catcher"
      ]
    );
  });
});

describe("isCommunityRecommendedApp", () => {
  it("identifies recommended apps that should be shown in community apps", () => {
    assert.equal(isCommunityRecommendedApp("group-chat"), true);
    assert.equal(isCommunityRecommendedApp(" daily-tech-radar "), true);
    assert.equal(isCommunityRecommendedApp("product-competition"), true);
    assert.equal(isCommunityRecommendedApp("design-review"), true);
    assert.equal(isCommunityRecommendedApp("draw-topic-app"), true);
    assert.equal(isCommunityRecommendedApp("omni-catcher"), true);
    assert.equal(isCommunityRecommendedApp("automation"), false);
    assert.equal(isCommunityRecommendedApp("vibe-design"), false);
  });
});

function createApp(
  overrides: Pick<AppCenterViewModel["apps"][number], "id" | "name"> &
    Partial<
      Pick<
        AppCenterViewModel["apps"][number],
        | "category"
        | "createdAtUnixMs"
        | "installed"
        | "sourceKind"
        | "statusLabelKey"
        | "tags"
      >
    >
): AppCenterViewModel["apps"][number] {
  return {
    availableVersion: "0.1.0",
    canDelete: true,
    canExport: true,
    canOpen: false,
    canOpenFactorySession: false,
    canOpenFolder: false,
    canOpenPackageFolder: false,
    canPublishFactoryUpdate: false,
    canReloadLocal: false,
    canReplaceIcon: false,
    canRetry: false,
    canUninstall: false,
    canUpdate: false,
    createdAtUnixMs: null,
    description: "",
    icon: {
      src: "app.png",
      type: "asset"
    },
    installed: false,
    primaryAction: "install",
    sourceKind: "local",
    status: "idle",
    statusLabelKey: "actions.installApp",
    statusPulse: false,
    statusTone: "neutral",
    tags: [],
    updateAvailable: false,
    version: "0.1.0",
    ...overrides
  };
}
