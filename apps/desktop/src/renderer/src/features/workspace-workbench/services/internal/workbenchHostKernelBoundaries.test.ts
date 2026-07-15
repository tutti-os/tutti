import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const productHostContractFiles = [
  "workbenchHostPorts.ts",
  "workbenchProductProfile.ts"
] as const;

const removedPrivateKernelFiles = [
  "workbenchCapabilityRegistry.ts",
  "workbenchHostCoordinator.ts",
  "workbenchHostSession.ts"
] as const;

test("desktop has no private host-kernel compatibility paths", () => {
  for (const file of removedPrivateKernelFiles) {
    assert.equal(
      existsSync(new URL(`./${file}`, import.meta.url)),
      false,
      file
    );
  }
});

test("desktop product host contracts have no DI or React runtime imports", () => {
  for (const file of productHostContractFiles) {
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

test("desktop product host contracts depend on surface contracts type-only", () => {
  for (const file of productHostContractFiles) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const surfaceImports = source.match(
      /^import(?: type)?[^;]+from "@tutti-os\/workbench-surface";/gm
    );

    for (const surfaceImport of surfaceImports ?? []) {
      assert.match(surfaceImport, /^import type /, file);
    }
  }
});
