import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(process.cwd(), "app/renderer/agentactivity.css"),
  "utf8"
);

describe("AgentGUIConversationRailItem CSS composition", () => {
  it("reserves the full visible action cluster before truncating the title", () => {
    const railItemStyles = css.slice(
      css.indexOf(".agent-gui-node__conversation-item {"),
      css.indexOf(".agent-gui-node__conversation-more-button")
    );

    expect(railItemStyles).toContain(
      "--agent-gui-conversation-actions-width: 72px;"
    );
    expect(railItemStyles).toContain(
      "--agent-gui-conversation-actions-inset: 4px;"
    );
    expect(railItemStyles).toContain(
      "--agent-gui-conversation-actions-gap: 8px;"
    );
    expect(railItemStyles).toContain(
      "gap: var(--agent-gui-conversation-actions-gap);"
    );
    expect(railItemStyles).toMatch(
      /conversation-item:has\([\s\S]*?conversation-open-window-button[\s\S]*?--agent-gui-conversation-actions-width: 96px;/
    );
    expect(railItemStyles).toMatch(
      /padding-right:\s*calc\(\s*var\(--agent-gui-conversation-actions-width\)\s*\+\s*var\(--agent-gui-conversation-actions-inset\)\s*\);/
    );
    expect(railItemStyles).toContain(
      "right: var(--agent-gui-conversation-actions-inset);"
    );
    expect(railItemStyles).toContain(
      "min-width: var(--agent-gui-conversation-actions-width);"
    );
    expect(railItemStyles).toMatch(
      /conversation-item:has\([\s\S]*?conversation-actions:focus-within[\s\S]*?conversation-select/
    );
  });

  it("keeps the optional leading mention icon compact and monochrome", () => {
    const mentionIconStyles = css.slice(
      css.indexOf(".agent-gui-node__conversation-title-mention-icon"),
      css.indexOf(".agent-gui-node__conversation-time")
    );

    expect(mentionIconStyles).toContain("color: var(--text-primary);");
    expect(mentionIconStyles).toContain("flex: 0 0 14px;");
    expect(mentionIconStyles).not.toContain("--rich-text-mention-session");
    expect(mentionIconStyles).not.toContain("--rich-text-mention-issue");
  });
});
