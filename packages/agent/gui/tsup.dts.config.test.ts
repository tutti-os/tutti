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
const packageRootSource = readFileSync(
  resolve(process.cwd(), "index.ts"),
  "utf8"
);

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

  it("builds and publishes the headless conversation rail controller", () => {
    expect(agentGUIBuildEntries["conversation-rail-controller"]).toBe(
      "agentConversationRailController.ts"
    );
    expect(
      packageManifest.publishConfig.exports["./conversation-rail-controller"]
    ).toEqual({
      types: "./dist/conversation-rail-controller.d.ts",
      import: "./dist/conversation-rail-controller.js"
    });
  });

  it("keeps conversation rail seams off the package root", () => {
    expect(packageRootSource).not.toContain(
      'from "./agentConversationRailController"'
    );
    expect(packageRootSource).not.toContain(
      'from "./agentConversationRailRuntime"'
    );
  });

  it("builds and publishes the DOM-free conversation rail projection", () => {
    expect(agentGUIBuildEntries["conversation-rail-projection"]).toBe(
      "conversationRailProjection.ts"
    );
    expect(
      packageManifest.publishConfig.exports["./conversation-rail-projection"]
    ).toEqual({
      types: "./dist/conversation-rail-projection.d.ts",
      import: "./dist/conversation-rail-projection.js"
    });
  });

  it("builds and publishes the DOM-free conversation projection", () => {
    expect(agentGUIBuildEntries["conversation-projection"]).toBe(
      "conversationProjection.ts"
    );
    expect(
      packageManifest.publishConfig.exports["./conversation-projection"]
    ).toEqual({
      types: "./dist/conversation-projection.d.ts",
      import: "./dist/conversation-projection.js"
    });
  });

  it("builds and publishes the DOM-free composer projection", () => {
    expect(agentGUIBuildEntries["composer-projection"]).toBe(
      "composerProjection.ts"
    );
    expect(
      packageManifest.publishConfig.exports["./composer-projection"]
    ).toEqual({
      types: "./dist/composer-projection.d.ts",
      import: "./dist/composer-projection.js"
    });
  });
});
