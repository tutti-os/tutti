import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCardPayload,
  buildSummaryElements,
  loadRelease,
  resolveMirroredAssetUrl,
  resolveReleaseAssetBaseUrl,
  resolveIntroText,
  resolveReleaseKind
} from "../../apps/desktop/scripts/send-release-feishu-card.mjs";

test("release Feishu card loads draft releases from the authenticated listing", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.includes("/releases/tags/")) {
      return new Response(null, { status: 404 });
    }
    return Response.json([
      {
        assets: [{ name: "Tutti-0.1.0-rc.4-mac-universal.dmg" }],
        draft: true,
        tag_name: "v0.1.0-rc.4"
      }
    ]);
  };

  const release = await loadRelease(
    "tutti-os/tutti",
    "v0.1.0-rc.4",
    "test-token"
  );

  assert.equal(release.draft, true);
  assert.equal(release.tag_name, "v0.1.0-rc.4");
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /\/releases\?per_page=100&page=1$/);
  assert.equal(requests[1].options.headers.authorization, "Bearer test-token");
});

function extractFieldMap(payload) {
  const fieldEntries = payload.card.elements
    .find((element) => element.tag === "div" && Array.isArray(element.fields))
    .fields.map((field) => {
      const [label, value] = field.text.content.split("\n");
      return [label.replace(/\*/g, ""), value];
    });

  return new Map(fieldEntries);
}

test("release Feishu card marks stable tags as latest releases", () => {
  assert.equal(resolveReleaseKind("v1.12.20"), "Stable latest release");
  assert.match(resolveIntroText("v1.12.20"), /GitHub Release/);
});

test("release Feishu card marks rc tags as prereleases", () => {
  assert.equal(
    resolveReleaseKind("v1.12.19-rc.0"),
    "Release candidate prerelease"
  );
  assert.match(resolveIntroText("v1.12.19-rc.0"), /RC 预览通道/);
});

test("release Feishu card marks beta tags as prereleases", () => {
  assert.equal(resolveReleaseKind("v1.12.19-beta.0"), "Beta prerelease");
  assert.match(resolveIntroText("v1.12.19-beta.0"), /Beta 预览通道/);
});

test("release Feishu card clearly marks draft builds without claiming public publication", () => {
  assert.equal(
    resolveReleaseKind("v1.12.20", "draft"),
    "Draft stable candidate"
  );
  assert.match(resolveIntroText("v1.12.20", "draft"), /仍为 Draft/);
  assert.match(resolveIntroText("v1.12.20", "draft"), /尚未更新公开下载通道/);

  const payload = buildCardPayload({
    actor: "jomeswang",
    branch: "release/0704",
    macUrl: "https://example.com/tutti.dmg",
    publicationStatus: "draft",
    releaseUrl: "https://github.com/tutti-os/tutti/releases/tag/v1.12.20",
    runUrl: "https://github.com/tutti-os/tutti/actions/runs/1",
    tag: "v1.12.20",
    target: "4039186abcdef0"
  });

  assert.equal(payload.card.header.title.content, "Tutti Draft 构建完成");
  assert.equal(payload.card.header.template, "orange");
  assert.equal(
    extractFieldMap(payload).get("构建类型"),
    "Draft stable candidate"
  );
});

test("release Feishu card includes tsh-aligned release context fields", () => {
  const payload = buildCardPayload({
    actor: "jomeswang",
    branch: "main",
    linuxUrl: "https://example.com/tutti.AppImage",
    macUrl: "https://example.com/tutti.dmg",
    releaseUrl: "https://github.com/tutti-os/tutti/releases/tag/v1.12.20",
    runUrl: "https://github.com/tutti-os/tutti/actions/runs/1",
    tag: "v1.12.20",
    target: "4039186abcdef0",
    winUrl: "https://example.com/tutti.exe"
  });

  const fields = extractFieldMap(payload);

  assert.equal(payload.card.header.title.content, "Tutti 发布完成");
  assert.equal(fields.get("版本号"), "v1.12.20");
  assert.equal(fields.get("构建类型"), "Stable latest release");
  assert.equal(fields.get("Commit"), "4039186");
  assert.equal(fields.get("部署分支"), "main");
  assert.equal(fields.get("部署人"), "jomeswang");

  const actionLabels = payload.card.elements
    .find((element) => element.tag === "action")
    .actions.map((action) => action.text.content);

  assert.deepEqual(actionLabels, [
    "下载 macOS",
    "打开 Release 页面",
    "查看流水线"
  ]);
});

test("release Feishu card includes Chinese release summary when available", () => {
  const payload = buildCardPayload({
    actor: "jomeswang",
    branch: "main",
    macUrl: "https://example.com/tutti.dmg",
    releaseUrl: "https://github.com/tutti-os/tutti/releases/tag/v1.12.20",
    runUrl: "https://github.com/tutti-os/tutti/actions/runs/1",
    summary: {
      zh: {
        headline: "本次版本聚焦桌面端发布链路稳定性。",
        sections: [
          {
            title: "发布与下载",
            items: ["稳定包下载入口只指向正式 release。"]
          }
        ],
        qaFocus: ["验证 macOS 首次安装和自动更新。"]
      }
    },
    tag: "v1.12.20",
    target: "4039186abcdef0"
  });
  const summaryElement = payload.card.elements.find((element) =>
    element.text?.content?.includes("本次更新")
  );

  assert.ok(summaryElement);
  assert.match(summaryElement.text.content, /稳定包下载入口只指向正式 release/);
  assert.match(summaryElement.text.content, /QA 重点/);
});

test("release Feishu card skips summary elements when summary is missing", () => {
  assert.deepEqual(buildSummaryElements(null), []);
});

test("release Feishu card can prefer mirrored asset links over GitHub asset URLs", () => {
  assert.equal(
    resolveReleaseAssetBaseUrl({
      bucket: "tutti-release-assets",
      explicitBaseUrl:
        "https://d111111abcdef8.cloudfront.net/desktop-release-assets",
      prefix: "desktop-release-assets"
    }),
    "https://d111111abcdef8.cloudfront.net/desktop-release-assets"
  );

  assert.equal(
    resolveReleaseAssetBaseUrl({
      bucket: "tutti-release-assets",
      explicitBaseUrl: "",
      prefix: "desktop-release-assets"
    }),
    "https://tutti-release-assets.s3-accelerate.amazonaws.com/desktop-release-assets"
  );
});

test("release Feishu card resolves mirrored macOS URLs from local artifact names", () => {
  assert.equal(
    resolveMirroredAssetUrl(
      [
        "Tutti-0.1.0-rc.4-mac-arm64.dmg",
        "Tutti-0.1.0-rc.4-mac-universal.dmg",
        "Tutti-0.1.0-rc.4-mac-x64.dmg",
        "Tutti-0.1.0-rc.4-win-x64.exe"
      ],
      /\.dmg$/i,
      "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-desktop-release-assets",
      "v0.1.0-rc.4"
    ),
    "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-desktop-release-assets/v0.1.0-rc.4/Tutti-0.1.0-rc.4-mac-universal.dmg"
  );
});
