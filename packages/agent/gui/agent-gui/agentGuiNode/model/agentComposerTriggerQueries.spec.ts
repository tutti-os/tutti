import { describe, expect, it } from "vitest";
import {
  draftForProviderSkillTrigger,
  filterProviderSkillsForTrigger,
  getAgentComposerTriggerQueryMatch,
  getPromptStartSlashCommandQuery
} from "./agentComposerTriggerQueries";

describe("agentComposerTriggerQueries", () => {
  it("matches prompt-start slash command queries through rich text trigger config", () => {
    expect(getPromptStartSlashCommandQuery("/")).toBe("");
    expect(getPromptStartSlashCommandQuery("/we")).toBe("we");
    expect(getPromptStartSlashCommandQuery("   /we")).toBe("we");
    expect(getPromptStartSlashCommandQuery("/web query")).toBeNull();
    expect(getPromptStartSlashCommandQuery("hello/web")).toBeNull();
    expect(getPromptStartSlashCommandQuery("hello /re")).toBeNull();
    expect(getPromptStartSlashCommandQuery("hello\n/re")).toBeNull();
    expect(getPromptStartSlashCommandQuery("`/re`")).toBeNull();
  });

  it("matches provider skill triggers at whitespace boundaries", () => {
    expect(getAgentComposerTriggerQueryMatch("$ar")).toEqual({
      end: 3,
      prefix: "$",
      query: "ar",
      start: 0
    });
    expect(getAgentComposerTriggerQueryMatch("please use $ar")).toEqual({
      end: 14,
      prefix: "$",
      query: "ar",
      start: 11
    });
    expect(getAgentComposerTriggerQueryMatch("please$ar")).toBeNull();
    expect(getAgentComposerTriggerQueryMatch("please use /ar")).toEqual({
      end: 14,
      prefix: "/",
      query: "ar",
      start: 11
    });
  });

  it("replaces the active skill token in the draft", () => {
    const match = getAgentComposerTriggerQueryMatch("please use $ar");

    expect(
      draftForProviderSkillTrigger({
        skill: {
          name: "architecture-review",
          trigger: "$architecture-review",
          sourceKind: "project"
        },
        currentDraft: "please use $ar",
        match
      })
    ).toBe("please use $architecture-review ");
  });

  it("uses the active prefix when inserting a provider skill", () => {
    const codexSlashMatch = getAgentComposerTriggerQueryMatch("/ar");
    expect(
      draftForProviderSkillTrigger({
        skill: {
          name: "architecture-review",
          trigger: "$architecture-review",
          sourceKind: "project"
        },
        currentDraft: "/ar",
        match: codexSlashMatch
      })
    ).toBe("/architecture-review ");

    const claudeDollarMatch = getAgentComposerTriggerQueryMatch("$front");
    expect(
      draftForProviderSkillTrigger({
        skill: {
          name: "frontend-design",
          trigger: "/product-design:frontend-design",
          sourceKind: "plugin"
        },
        currentDraft: "$front",
        match: claudeDollarMatch
      })
    ).toBe("$product-design:frontend-design ");
  });

  it("filters provider skills through slash and dollar aliases", () => {
    expect(
      filterProviderSkillsForTrigger({
        skills: [
          {
            name: "architecture-review",
            trigger: "$architecture-review",
            sourceKind: "project"
          }
        ],
        query: "arch",
        triggerPrefix: "/"
      }).map((skill) => skill.name)
    ).toEqual(["architecture-review"]);

    expect(
      filterProviderSkillsForTrigger({
        skills: [
          {
            name: "frontend-design",
            trigger: "/product-design:frontend-design",
            sourceKind: "plugin"
          }
        ],
        query: "product",
        triggerPrefix: "$"
      }).map((skill) => skill.name)
    ).toEqual(["frontend-design"]);
  });
});
