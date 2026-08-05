import { describe, expect, it } from "vitest";
import type { AgentHostComposerCapability } from "../../../host/agentHostApi";
import type { AgentSlashCommand } from "../model/agentSlashCommandProviderPolicy";
import { nativeCapabilitiesForSlashPresentation } from "./useComposerPaletteCatalog";

const INVENTORY = [
  {
    id: "browser",
    semantic: "browserUse",
    label: "Browser",
    description: null,
    status: "ready"
  },
  {
    id: "computer",
    semantic: "computerUse",
    label: "Computer Use",
    description: null,
    status: "ready"
  },
  {
    id: "sites",
    semantic: "sites",
    label: "Sites",
    description: null,
    status: "ready"
  }
] satisfies readonly AgentHostComposerCapability[];

describe("native capability slash presentation", () => {
  it("keeps all inventory semantics when there is no legacy action", () => {
    expect(nativeCapabilitiesForSlashPresentation(INVENTORY, [])).toEqual(
      INVENTORY
    );
  });

  it("reuses the existing Browser and Computer actions without dropping Sites", () => {
    const commands = [
      { capability: "browserUse", kind: "capability", name: "browser" },
      { capability: "computerUse", kind: "capability", name: "computer" }
    ] satisfies readonly AgentSlashCommand[];

    expect(
      nativeCapabilitiesForSlashPresentation(INVENTORY, commands).map(
        (capability) => capability.semantic
      )
    ).toEqual(["sites"]);
  });
});
