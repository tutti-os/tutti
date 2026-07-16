import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "agent-gui/agentGuiNode/composer/ComposerFooter.tsx"),
  "utf8"
);

describe("ComposerFooter trigger composition", () => {
  it("does not compose TooltipTrigger and SelectTrigger onto one button", () => {
    expect(source).not.toMatch(/<TooltipTrigger asChild>\s*<SelectTrigger/u);
  });

  it("keeps native titles on composer select triggers", () => {
    expect(source).toContain("title={labels.addContent}");
    expect(source).toContain("title={labels.handoffConversationTooltip}");
  });

  it("renders Plan and Tutti as independent removable badges without an execution-mode dropdown", () => {
    expect(source).not.toContain('data-testid="agent-composer-execution-mode"');
    expect(source).toContain('data-agent-plan-mode-badge="true"');
    expect(source).toContain('data-agent-tutti-mode-badge="true"');
    expect(source).toContain("isPlanModeActive ?");
    expect(source).toContain("isTuttiModeActive ?");
    expect(source).toContain("disabled={isTuttiModeUpdating}");
  });
});
