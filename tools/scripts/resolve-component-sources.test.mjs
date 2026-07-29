import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  componentSymbolCandidates,
  resolveComponentSources
} from "./resolve-component-sources.mjs";

test("component symbol candidates unwrap React compiler names", () => {
  assert.deepEqual(componentSymbolCandidates("AgentItem2"), [
    "AgentItem2",
    "AgentItem"
  ]);
  assert.deepEqual(componentSymbolCandidates("ForwardRef(BareButton2)"), [
    "BareButton2",
    "BareButton"
  ]);
  assert.deepEqual(componentSymbolCandidates("Primitive.span"), []);
});

test("component source resolver links only unambiguous declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "tutti-component-sources-"));
  try {
    const packageDirectory = join(root, "packages", "demo");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "AgentItem.tsx"),
      [
        "export const AgentItem = memo(function AgentItem() {",
        "  return null;",
        "});",
        "function HeaderFrame() { return null; }",
        ""
      ].join("\n")
    );
    const resolved = await resolveComponentSources(
      [
        { name: "AgentItem2", count: 3 },
        { name: "HeaderFrame", count: 1 },
        { name: "Primitive.span", count: 9 }
      ],
      root
    );

    assert.deepEqual(resolved[0].source, {
      confidence: "static-declaration",
      file: "packages/demo/AgentItem.tsx",
      line: 1,
      symbol: "AgentItem"
    });
    assert.equal(resolved[1].source.line, 4);
    assert.equal(resolved[2].source, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
