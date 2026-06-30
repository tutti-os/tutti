import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("WorkspaceNodeWindow chrome", () => {
  it("places traffic-light controls on the leading side", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "WorkspaceNodeWindow.tsx"),
      "utf8"
    );

    expect(source).toMatch(
      /data-workspace-node-window-controls="true"[\s\S]*data-workspace-node-window-title="true"/
    );
    expect(source).toMatch(/workspace-node-window__header relative flex/);
    expect(source).toMatch(
      /workspace-node-window__controls[\s\S]*absolute left-4 top-1\/2/
    );
    expect(source).toMatch(
      /workspace-node-window__title[\s\S]*ml-\[64px\][\s\S]*text-\[15px\][\s\S]*leading-5/
    );
    expect(source).toMatch(/data-workspace-node-window-traffic-light=\{tone\}/);
    expect(source).toMatch(/tone === "close"[\s\S]*#ff5f57/);
    expect(source).toMatch(/tone === "minimize"[\s\S]*#ffbd2e/);
    expect(source).toMatch(/tone === "maximize"[\s\S]*#28c840/);
    expect(source).not.toMatch(
      /<CanvasNodeGhostIconButton[\s\S]*common\.close/
    );
    expect(source).not.toMatch(
      /<CanvasNodeGhostIconButton[\s\S]*common\.maximize/
    );
  });
});
