import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(
    process.cwd(),
    "agent-gui/agentGuiNode/view/AgentGUIConversationRailSectionHeader.tsx"
  ),
  "utf8"
);

describe("AgentGUIConversationRailSectionHeader trigger composition", () => {
  it("keeps tooltip and dropdown refs on separate DOM elements", () => {
    expect(source).not.toMatch(
      /<DropdownMenuTrigger asChild>\s*<TooltipTrigger asChild>/u
    );
    expect(
      source.match(
        /<TooltipTrigger asChild>\s*<span(?:(?!<\/span>)[\s\S])*?<DropdownMenuTrigger asChild>/gu
      )
    ).toHaveLength(2);
  });
});
