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
const composerSource = readFileSync(
  join(process.cwd(), "agent-gui/agentGuiNode/AgentComposer.tsx"),
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
      /const trigger = \(\s*<span className="inline-flex">\s*<SelectTrigger/u
    );
    expect(handoffMenuSource).toContain(
      "<TooltipTrigger asChild>{trigger}</TooltipTrigger>"
    );
  });

  it("uses design-system tooltips instead of suppressed native titles", () => {
    expect(source).not.toContain("title={labels.addContent}");
    expect(source).toMatch(
      /<TooltipContent side="top">\s*\{labels\.addContent\}\s*<\/TooltipContent>/u
    );
    expect(handoffMenuSource).not.toContain("title={labels.tooltip}");
    expect(handoffMenuSource).toContain(
      "const tooltip = labels.tooltip.trim();"
    );
    expect(handoffMenuSource).toContain(
      '<TooltipContent side="top">{tooltip}</TooltipContent>'
    );
  });

  it("keeps the quick-prompt slot after handoff/provider and before status badges", () => {
    const slotIndex = source.indexOf("{quickPromptControl}");
    const providerIndex = source.indexOf("selectedProviderSwitchTarget");
    const planIndex = source.indexOf("composerSettings.supportsPlanMode");

    expect(slotIndex).toBeGreaterThan(providerIndex);
    expect(slotIndex).toBeLessThan(planIndex);
  });

  it("closes every competing composer disclosure before quick prompts open", () => {
    expect(composerSource).toMatch(
      /closeQuickPromptCompetingDisclosure[\s\S]*closeFileMentionPalette\(\)[\s\S]*closeSlashFloatingMenu\(\)/u
    );
    expect(composerSource).toContain(
      "onBeforeOpen: closeQuickPromptCompetingDisclosure"
    );
  });
});
