import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("browser workbench node syncs open-url activations into existing browser nodes", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
    "utf8"
  );

  assert.match(
    source,
    /createElement\(BrowserNode,[\s\S]*showHeader:\s*false,[\s\S]*syncDefaultUrl:\s*true/
  );
});

test("browser workbench node forwards navigation callbacks to browser nodes", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
    "utf8"
  );

  assert.match(
    source,
    /onNavigated:\s*onNavigated[\s\S]*nodeId:\s*context\.node\.id[\s\S]*url/
  );
});

test("browser workbench node lets hosts replace default traffic lights", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
    "utf8"
  );

  assert.match(source, /renderTrafficLights\?:/);
  assert.match(
    source,
    /defaultActions:\s*renderTrafficLights[\s\S]*renderTrafficLights\(headerContext\)[\s\S]*headerContext\.defaultActions/
  );
});

test("browser workbench node exposes native minimized snapshot capture", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
    "utf8"
  );

  assert.match(
    source,
    /minimizedDock:\s*{[\s\S]*capturePreview:\s*\(\{\s*node\s*\}\)\s*=>[\s\S]*feature\.hostApi\.capturePreview\?\.\(\{\s*nodeId:\s*node\.id\s*\}\)[\s\S]*kind:\s*"snapshot"/
  );
});
