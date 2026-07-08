import { describe, expect, it } from "vitest";
import {
  cursorColorfulUrl,
  cursorFlatFilledIconUrl,
  opencodeFlatFilledIconUrl,
  resolveAgentGuiSessionProviderFlatIconUrl,
  resolveAgentGuiSessionProviderIconUrl,
  tuttiFlatFilledIconUrl
} from "./agentGuiSessionProviderIconUrls.ts";
import {
  claudeRoundedUrl,
  codexRoundedUrl,
  manageAgentTuttiUrl,
  opencodeRoundedUrl
} from "./managedAgentIconAssets.ts";

describe("resolveAgentGuiSessionProviderIconUrl", () => {
  it("returns colorful rounded icons that stay visible on the dark header", () => {
    expect(resolveAgentGuiSessionProviderIconUrl("claude-code")).toBe(
      claudeRoundedUrl
    );
    expect(resolveAgentGuiSessionProviderIconUrl("codex")).toBe(
      codexRoundedUrl
    );
  });

  it("returns the colorful cursor icon for cursor sessions", () => {
    expect(resolveAgentGuiSessionProviderIconUrl("cursor")).toBe(
      cursorColorfulUrl
    );
  });

  it("keeps the legacy flat filled cursor icon available for older callers", () => {
    expect(cursorFlatFilledIconUrl).toEqual(expect.any(String));
  });

  it("returns the colorful tutti icon for native tutti sessions", () => {
    expect(resolveAgentGuiSessionProviderIconUrl("tutti")).toBe(
      manageAgentTuttiUrl
    );
    expect(resolveAgentGuiSessionProviderIconUrl("tutti-agent")).toBe(
      manageAgentTuttiUrl
    );
    expect(resolveAgentGuiSessionProviderIconUrl("nexight")).toBe(
      manageAgentTuttiUrl
    );
  });

  it("returns the colorful opencode icon for opencode sessions", () => {
    expect(resolveAgentGuiSessionProviderIconUrl("opencode")).toBe(
      opencodeRoundedUrl
    );
  });

  it("returns null for providers without a session icon override", () => {
    expect(resolveAgentGuiSessionProviderIconUrl("hermes")).toBeNull();
  });
});

describe("resolveAgentGuiSessionProviderFlatIconUrl", () => {
  it("returns the flat filled cursor icon for masked surfaces", () => {
    expect(resolveAgentGuiSessionProviderFlatIconUrl("cursor")).toBe(
      cursorFlatFilledIconUrl
    );
  });

  it("returns the flat filled tutti icon for tutti sessions", () => {
    expect(resolveAgentGuiSessionProviderFlatIconUrl("tutti")).toBe(
      tuttiFlatFilledIconUrl
    );
    expect(resolveAgentGuiSessionProviderFlatIconUrl("nexight")).toBe(
      tuttiFlatFilledIconUrl
    );
    expect(resolveAgentGuiSessionProviderFlatIconUrl("tutti-agent")).toBe(
      tuttiFlatFilledIconUrl
    );
  });

  it("returns the flat filled opencode icon for masked surfaces", () => {
    expect(resolveAgentGuiSessionProviderFlatIconUrl("opencode")).toBe(
      opencodeFlatFilledIconUrl
    );
  });

  it("returns null for providers without a flat session icon", () => {
    expect(resolveAgentGuiSessionProviderFlatIconUrl("hermes")).toBeNull();
  });
});
