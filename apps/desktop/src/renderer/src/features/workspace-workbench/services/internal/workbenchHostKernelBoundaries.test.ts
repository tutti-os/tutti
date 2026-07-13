import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const neutralKernelFiles = [
  "workbenchCapabilityRegistry.ts",
  "workbenchHostCoordinator.ts",
  "workbenchHostPorts.ts",
  "workbenchHostSession.ts",
  "workbenchProductProfile.ts"
] as const;

test("private workbench host kernel has no product, DI, or React runtime imports", () => {
  for (const file of neutralKernelFiles) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

    assert.doesNotMatch(
      source,
      /from "(?:@preload(?:\/[^"]*)?|@renderer(?:\/[^"]*)?|@shared(?:\/[^"]*)?|@tutti-os\/(?:agent-|browser-node|client-|infra\/di|workspace-)[^"]*|react(?:\/[^"]*)?)"/,
      file
    );
    assert.doesNotMatch(
      source,
      /\b(?:Tutti|Desktop|Electron|Tuttid|agent|terminal|appCenter|wallpaper|onboarding)\b/,
      file
    );
  }
});

test("private workbench host kernel depends on surface contracts type-only", () => {
  for (const file of neutralKernelFiles) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const surfaceImports = source.match(
      /^import(?: type)?[^;]+from "@tutti-os\/workbench-surface";/gm
    );

    for (const surfaceImport of surfaceImports ?? []) {
      assert.match(surfaceImport, /^import type /, file);
    }
  }
});
