import { describe, expect, it } from "vitest";
import {
  getWorkspaceSettingsPanelStore,
  openWorkspaceSettingsPanel
} from "./workspaceSettingsPanelStore.ts";

describe("workspace settings panel deep-link intent", () => {
  it("carries section, pane, and provider and bumps the sequence", () => {
    const before = getWorkspaceSettingsPanelStore().requestSequence;
    openWorkspaceSettingsPanel({
      section: "agent",
      pane: "agents",
      provider: "hermes"
    });
    const store = getWorkspaceSettingsPanelStore();
    expect(store.section).toBe("agent");
    expect(store.pane).toBe("agents");
    expect(store.provider).toBe("hermes");
    expect(store.requestSequence).toBe(before + 1);
  });

  it("resets pane and provider when omitted", () => {
    openWorkspaceSettingsPanel({
      section: "agent",
      pane: "agents",
      provider: "hermes"
    });
    openWorkspaceSettingsPanel({ section: "appearance" });
    const store = getWorkspaceSettingsPanelStore();
    expect(store.section).toBe("appearance");
    expect(store.pane).toBeNull();
    expect(store.provider).toBeNull();
  });
});
