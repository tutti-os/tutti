import { describe, expect, it, vi } from "vitest";
import { agentGuiI18nResources } from "./i18n/index.ts";
import {
  migratedAgentGUIProviderIdentityCatalog,
  agentGUIProviderIdentityDisplayName,
  resolveAgentGUIProviderCatalogIdentity,
  resolveMigratedAgentGUIProviderIdentity
} from "./providerIdentityCatalog.ts";

describe("provider identity catalog", () => {
  it("reads the migrated Codex identity and target from the generated catalog", () => {
    expect(resolveMigratedAgentGUIProviderIdentity("codex")).toMatchObject({
      providerId: "codex",
      displayName: "Codex",
      iconKey: "codex",
      localeKey: "agentHost.agentGui.conversationFilterCodex",
      target: {
        id: "local:codex",
        launchRefType: "local_cli",
        enabled: true,
        sortOrder: 10
      },
      desktop: {
        runtimeProbeFallback: ""
      },
      source: "generated"
    });
  });

  it("reads desktop runtime probe fallback strategy from the generated catalog", () => {
    expect(
      resolveMigratedAgentGUIProviderIdentity("cursor")?.desktop
    ).toMatchObject({
      runtimeProbeFallback: "direct"
    });
  });

  it("reads OpenCode aliases, identity, and target only from the generated catalog", () => {
    expect(resolveMigratedAgentGUIProviderIdentity("open-code")).toMatchObject({
      providerId: "opencode",
      displayName: "OpenCode",
      iconKey: "opencode",
      localeKey: "agentHost.agentGui.conversationFilterOpenCode",
      aliases: ["open-code", "open code", "opencode-ai", "opencode_ai"],
      target: {
        id: "local:opencode",
        launchRefType: "local_cli",
        enabled: true,
        sortOrder: 50
      },
      source: "generated"
    });
  });

  it("reads the migrated Claude identity from the generated catalog", () => {
    expect(resolveAgentGUIProviderCatalogIdentity("Claude Code")).toMatchObject(
      {
        providerId: "claude-code",
        displayName: "Claude Code",
        source: "generated"
      }
    );
  });

  it("does not silently invent an identity for unknown providers", () => {
    expect(resolveAgentGUIProviderCatalogIdentity("mystery")).toBeNull();
  });

  it("uses the generated locale key for migrated display names", () => {
    const identity = resolveMigratedAgentGUIProviderIdentity("codex");
    expect(identity).not.toBeNull();
    const t = vi.fn(() => "科德克斯");
    expect(agentGUIProviderIdentityDisplayName(identity!, t)).toBe("科德克斯");
    expect(t).toHaveBeenCalledWith(
      "agentHost.agentGui.conversationFilterCodex"
    );
  });

  it("resolves every generated locale key in every AgentGUI locale", () => {
    for (const [locale, resource] of Object.entries(agentGuiI18nResources)) {
      for (const identity of migratedAgentGUIProviderIdentityCatalog) {
        expect(
          valueAtPath(resource, identity.localeKey),
          `${locale}:${identity.providerId}:${identity.localeKey}`
        ).toBeTypeOf("string");
      }
    }
  });

  it("contains unique generated provider and target ids", () => {
    expect(
      new Set(
        migratedAgentGUIProviderIdentityCatalog.map((entry) => entry.providerId)
      ).size
    ).toBe(migratedAgentGUIProviderIdentityCatalog.length);
    expect(
      new Set(
        migratedAgentGUIProviderIdentityCatalog.map((entry) => entry.target.id)
      ).size
    ).toBe(migratedAgentGUIProviderIdentityCatalog.length);
  });
});

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, value);
}
