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
  it("keeps tooltip and select triggers on separate elements", () => {
    expect(source).not.toMatch(/<TooltipTrigger asChild>\s*<SelectTrigger/u);
    expect(handoffMenuSource).not.toMatch(
      /<TooltipTrigger asChild>\s*<SelectTrigger/u
    );
    expect(source).toMatch(
      /<TooltipTrigger asChild>\s*<span className="inline-flex">\s*<SelectTrigger/u
    );
    expect(handoffMenuSource).toMatch(
      /<TooltipTrigger asChild>\s*<span className="inline-flex">\s*<SelectTrigger/u
    );
  });

  it("uses design-system tooltips instead of suppressed native titles", () => {
    expect(source).not.toContain("title={labels.addContent}");
    expect(source).toMatch(
      /<TooltipContent side="top">\s*\{labels\.addContent\}\s*<\/TooltipContent>/u
    );
    expect(handoffMenuSource).not.toContain("title={labels.tooltip}");
    expect(handoffMenuSource).toContain(
      '<TooltipContent side="top">{labels.tooltip}</TooltipContent>'
    );
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
