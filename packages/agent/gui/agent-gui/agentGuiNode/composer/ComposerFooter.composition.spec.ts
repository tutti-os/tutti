import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "agent-gui/agentGuiNode/composer/ComposerFooter.tsx"),
  "utf8"
);
const handoffMenuSource = readFileSync(
  join(process.cwd(), "agent-gui/agentGuiNode/composer/AgentHandoffMenu.tsx"),
  "utf8"
);

describe("ComposerFooter trigger composition", () => {
  it("does not compose TooltipTrigger and SelectTrigger onto one button", () => {
    expect(source).not.toMatch(/<TooltipTrigger asChild>\s*<SelectTrigger/u);
    expect(handoffMenuSource).not.toMatch(
      /<TooltipTrigger asChild>\s*<SelectTrigger/u
    );
  });

  it("keeps native titles on composer select triggers", () => {
    expect(source).toContain("title={labels.addContent}");
    expect(handoffMenuSource).toContain("title={labels.tooltip}");
  });
});
