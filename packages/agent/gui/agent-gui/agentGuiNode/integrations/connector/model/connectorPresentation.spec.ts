import { describe, expect, it } from "vitest";
import type { AgentGUIProviderSkillOption } from "../../../model/agentGuiNodeTypes";
import {
  projectConnectorComposerItems,
  projectConnectorPaletteItem,
  projectConnectorSelectionItems
} from "./connectorPresentation";

function connector(
  connectorKey: string,
  status: AgentGUIProviderSkillOption["status"]
): AgentGUIProviderSkillOption {
  return {
    connectorKey,
    kind: "connector",
    name: `Connector ${connectorKey}`,
    sourceKind: "connector",
    status,
    trigger: `/${connectorKey}`
  };
}

describe("connector presentation projection", () => {
  it("projects only identified connectors and keeps authorization separate from draft selection", () => {
    expect(
      projectConnectorComposerItems(
        [
          { name: "Ordinary skill", sourceKind: "personal", trigger: "$skill" },
          connector("github", "available"),
          connector("notion", "authRequired"),
          { ...connector("", "setupRequired"), connectorKey: " " }
        ],
        ["github"]
      )
    ).toEqual([
      expect.objectContaining({
        connectorKey: "github",
        selected: true,
        status: "connected"
      }),
      expect.objectContaining({
        connectorKey: "notion",
        selected: false,
        status: "authorization_required"
      })
    ]);
  });

  it("projects draft labels and palette status from the authoritative option", () => {
    const notion = {
      ...connector("notion", "unsupported"),
      iconUrl: "/notion.png",
      name: "Notion"
    };

    expect(
      projectConnectorSelectionItems(
        [{ connectorKey: "notion" }, { connectorKey: "missing" }],
        [notion]
      )
    ).toEqual([
      { connectorKey: "notion", iconUrl: "/notion.png", name: "Notion" },
      { connectorKey: "missing", iconUrl: undefined, name: "missing" }
    ]);
    expect(
      projectConnectorPaletteItem(notion, "notion", "Workspace search")
    ).toEqual({
      connectorKey: "notion",
      description: "Workspace search",
      iconUrl: "/notion.png",
      label: "notion",
      status: "unsupported"
    });
  });

  it("preserves the stopped runtime state for the composer switch", () => {
    expect(
      projectConnectorComposerItems([connector("linear", "disabled")])
    ).toEqual([
      expect.objectContaining({
        connectorKey: "linear",
        status: "disabled"
      })
    ]);
  });
});
