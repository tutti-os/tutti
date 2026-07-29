import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  packedFilesWithRawSvgDataUrls,
  packedFilesWithRelativeSvgUrls
} from "./package-pack-svg-data-urls.mjs";

test("reports raw SVG data URLs in packed JavaScript", async () => {
  const root = await mkdtemp(join(tmpdir(), "tutti-pack-svg-data-url-"));
  try {
    await mkdir(join(root, "dist"));
    await writeFile(
      join(root, "dist/index.js"),
      'const icon = "data:image/svg+xml,' +
        "<" +
        'svg width=\\"24\\"></svg>";\n'
    );

    assert.deepEqual(await packedFilesWithRawSvgDataUrls(root), [
      "dist/index.js"
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("reports relative SVG URLs that consumers cannot resolve", async () => {
  const root = await mkdtemp(join(tmpdir(), "tutti-pack-svg-data-url-"));
  try {
    await mkdir(join(root, "dist"));
    await writeFile(
      join(root, "dist/index.js"),
      'const icon = "./icon-ABC123.svg";\n'
    );

    assert.deepEqual(await packedFilesWithRelativeSvgUrls(root), [
      "dist/index.js"
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("accepts CSS-safe SVG data URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "tutti-pack-svg-data-url-"));
  try {
    await mkdir(join(root, "dist"));
    await writeFile(
      join(root, "dist/index.js"),
      [
        'const encoded = "data:image/svg+xml,%3Csvg%20width%3D%2724%27%3E%3C%2Fsvg%3E";',
        'const base64 = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";',
        'const moduleRelative = new URL("./icon.svg", import.meta.url).href;'
      ].join("\n")
    );

    assert.deepEqual(await packedFilesWithRawSvgDataUrls(root), []);
    assert.deepEqual(await packedFilesWithRelativeSvgUrls(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
