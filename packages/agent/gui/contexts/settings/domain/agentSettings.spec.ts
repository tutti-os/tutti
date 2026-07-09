import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_SETTINGS,
  MAX_UI_FONT_SIZE,
  MIN_UI_FONT_SIZE,
  normalizeAgentSettings
} from "./agentSettings";

describe("normalizeAgentSettings", () => {
  it("ignores removed legacy settings keys", () => {
    const provider = DEFAULT_AGENT_SETTINGS.defaultProvider;

    const normalized = normalizeAgentSettings({
      modelByProvider: {
        [provider]: "legacy-model"
      },
      normalizeZoomOnTerminalClick: !DEFAULT_AGENT_SETTINGS.focusNodeOnClick,
      uiFontScalePercent: 140
    });

    expect(normalized.customModelByProvider[provider]).toBe(
      DEFAULT_AGENT_SETTINGS.customModelByProvider[provider]
    );
    expect(normalized.customModelEnabledByProvider[provider]).toBe(
      DEFAULT_AGENT_SETTINGS.customModelEnabledByProvider[provider]
    );
    expect(normalized.focusNodeOnClick).toBe(
      DEFAULT_AGENT_SETTINGS.focusNodeOnClick
    );
    expect(normalized.uiFontSize).toBe(DEFAULT_AGENT_SETTINGS.uiFontSize);
  });

  it("normalizes current settings keys", () => {
    const provider = DEFAULT_AGENT_SETTINGS.defaultProvider;
    const uiFontSize =
      DEFAULT_AGENT_SETTINGS.uiFontSize === MIN_UI_FONT_SIZE
        ? MAX_UI_FONT_SIZE
        : MIN_UI_FONT_SIZE;

    const normalized = normalizeAgentSettings({
      customModelEnabledByProvider: {
        [provider]: true
      },
      customModelByProvider: {
        [provider]: "current-model"
      },
      focusNodeOnClick: !DEFAULT_AGENT_SETTINGS.focusNodeOnClick,
      uiFontSize
    });

    expect(normalized.customModelEnabledByProvider[provider]).toBe(true);
    expect(normalized.customModelByProvider[provider]).toBe("current-model");
    expect(normalized.focusNodeOnClick).toBe(
      !DEFAULT_AGENT_SETTINGS.focusNodeOnClick
    );
    expect(normalized.uiFontSize).toBe(uiFontSize);
  });
});
