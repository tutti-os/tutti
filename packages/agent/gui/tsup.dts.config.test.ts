import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentGUIBuildEntries,
  agentGUIDtsEntryGroups
} from "./build/agentGuiBuildEntries";

const packageManifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8")
) as {
  publishConfig: {
    exports: Record<string, unknown>;
  };
};

describe("Agent GUI declaration build groups", () => {
  it("cover every runtime entry exactly once", () => {
    const declarationEntries = agentGUIDtsEntryGroups.flat();
    const runtimeEntries = Object.keys(agentGUIBuildEntries).sort();

    expect(new Set(declarationEntries).size).toBe(declarationEntries.length);
    expect([...declarationEntries].sort()).toEqual(runtimeEntries);
  });

  it("builds and publishes the workspace settings panel contract", () => {
    expect(agentGUIBuildEntries["workspace-settings-panel"]).toBe(
      "shared/workspaceSettingsPanel/workspaceSettingsPanelStore.ts"
    );
    expect(
      packageManifest.publishConfig.exports["./workspace-settings-panel"]
    ).toEqual({
      types: "./dist/workspace-settings-panel.d.ts",
      import: "./dist/workspace-settings-panel.js"
    });
  });

  it("builds and publishes the conversation rail runtime contract", () => {
    expect(agentGUIBuildEntries["conversation-rail-runtime"]).toBe(
      "agentConversationRailRuntime.ts"
    );
    expect(
      packageManifest.publishConfig.exports["./conversation-rail-runtime"]
    ).toEqual({
      types: "./dist/conversation-rail-runtime.d.ts",
      import: "./dist/conversation-rail-runtime.js"
    });
  });
});
