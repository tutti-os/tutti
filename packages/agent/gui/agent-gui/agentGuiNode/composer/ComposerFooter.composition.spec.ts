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

  it("opens the Tutti budget popup from the badge and clears the mode only via the inline remove button", () => {
    expect(source).toContain("<TuttiBudgetPopover");
    expect(source).toContain('data-agent-tutti-mode-remove="true"');
    expect(source).toContain("onClick={onClearTuttiMode}");
    // The badge itself must trigger the popup, not remove the mode: the only
    // onClearTuttiMode wiring lives on the dedicated remove button.
    expect(source.match(/onClearTuttiMode\}/gu)).toHaveLength(1);
  });
});
