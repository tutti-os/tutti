import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  missingPackedModuleRelativeAssets,
  missingPackedRelativeImports
} from "./package-pack-relative-imports.mjs";

test("reports a runtime-relative import omitted from a packed package", async () => {
  const root = await mkdtemp(join(tmpdir(), "tutti-pack-imports-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/main.ts"),
      'import { value } from "./runtime.ts";\nprocess.stdout.write(value);\n'
    );

    assert.deepEqual(await missingPackedRelativeImports(root, "src/main.ts"), [
      "src/main.ts -> ./runtime.ts"
    ]);

    await writeFile(
      join(root, "src/runtime.ts"),
      'export const value = "ok";\n'
    );
    assert.deepEqual(
      await missingPackedRelativeImports(root, "src/main.ts"),
      []
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("follows re-exports and nested relative imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "tutti-pack-imports-"));
  try {
    await mkdir(join(root, "src/nested"), { recursive: true });
    await writeFile(
      join(root, "src/main.ts"),
      'export { value } from "./nested/index.ts";\n'
    );
    await writeFile(
      join(root, "src/nested/index.ts"),
      'export { value } from "./value.ts";\n'
    );

    assert.deepEqual(await missingPackedRelativeImports(root, "src/main.ts"), [
      "src/nested/index.ts -> ./value.ts"
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("reports a module-relative asset omitted from a packed package", async () => {
  const root = await mkdtemp(join(tmpdir(), "tutti-pack-assets-"));
  try {
    await mkdir(join(root, "dist"));
    await writeFile(
      join(root, "dist/index.js"),
      'const icon = new URL("../assets/icon.png", import.meta.url);\n'
    );

    assert.deepEqual(await missingPackedModuleRelativeAssets(root), [
      "dist/index.js -> ../assets/icon.png"
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("accepts a packed module-relative asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "tutti-pack-assets-"));
  try {
    await mkdir(join(root, "dist/assets"), { recursive: true });
    await writeFile(
      join(root, "dist/index.js"),
      'const icon = new URL("./assets/icon.png?url", import.meta.url);\n'
    );
    await writeFile(join(root, "dist/assets/icon.png"), "png");

    assert.deepEqual(await missingPackedModuleRelativeAssets(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
