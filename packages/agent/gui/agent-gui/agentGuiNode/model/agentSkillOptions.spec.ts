import { describe, expect, it } from "vitest";
import {
  labelForProviderSkill,
  promptForProviderSkills,
  skillDescriptionForDisplay
} from "./agentSkillOptions";

describe("agentSkillOptions", () => {
  it("creates display labels without trigger prefixes", () => {
    expect(
      labelForProviderSkill(
        {
          name: "caveman",
          trigger: "$caveman",
          sourceKind: "personal"
        },
        "/"
      )
    ).toBe("caveman");
    expect(
      labelForProviderSkill(
        {
          name: "frontend-design",
          trigger: "/product-design:frontend-design",
          sourceKind: "plugin"
        },
        "$"
      )
    ).toBe("product-design:frontend-design");
  });

  it("normalizes known skill aliases before sending to the provider", () => {
    expect(
      promptForProviderSkills({
        prompt: "/caveman keep /init",
        skills: [
          {
            name: "caveman",
            trigger: "$caveman",
            invocation: "promptItem",
            sourceKind: "personal"
          }
        ]
      })
    ).toBe("$caveman keep /init");

    expect(
      promptForProviderSkills({
        prompt: "$product-design:frontend-design keep /init",
        skills: [
          {
            name: "frontend-design",
            trigger: "/product-design:frontend-design",
            invocation: "textTrigger",
            sourceKind: "plugin",
            pluginName: "product-design"
          }
        ]
      })
    ).toBe("/product-design:frontend-design keep /init");
  });

  it("does not guess an invocation syntax when the descriptor omitted it", () => {
    expect(
      promptForProviderSkills({
        prompt: "$unknown keep /init",
        skills: [
          {
            name: "unknown",
            trigger: "/unknown",
            sourceKind: "plugin"
          }
        ]
      })
    ).toBe("$unknown keep /init");
  });

  it("uses the first useful description line", () => {
    expect(skillDescriptionForDisplay("\n  Search docs  \nMore details")).toBe(
      "Search docs"
    );
  });
});
