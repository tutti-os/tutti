import { describe, expect, it } from "vitest";
import {
  shouldHideSkillPresentationEntry,
  skillPresentationEntries
} from "./skillPresentationEntries";

describe("skill presentation entries", () => {
  it("hides a Plugin-proven Skill only from slash presentation", () => {
    const [entry] = skillPresentationEntries([
      {
        kind: "skill",
        name: "sites:sites-building",
        path: "/plugins/sites/skills/build/SKILL.md",
        sourceKind: "bundled",
        trigger: "$sites:sites-building"
      }
    ]);
    expect(entry).toBeDefined();
    const hiddenSlashSkillEntryIds = new Set([entry!.entryId]);

    expect(
      shouldHideSkillPresentationEntry({
        entryId: entry!.entryId,
        hiddenSlashSkillEntryIds,
        prefix: "/"
      })
    ).toBe(true);
    expect(
      shouldHideSkillPresentationEntry({
        entryId: entry!.entryId,
        hiddenSlashSkillEntryIds,
        prefix: "$"
      })
    ).toBe(false);
  });
});
