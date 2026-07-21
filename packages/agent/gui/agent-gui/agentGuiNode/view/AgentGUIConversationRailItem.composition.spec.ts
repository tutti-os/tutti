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
    expect(railItemStyles).toMatch(
      /conversation-item:has\([\s\S]*?conversation-open-window-button[\s\S]*?--agent-gui-conversation-actions-width: 96px;/
    );
    expect(railItemStyles).toContain(
      "padding-right: calc(var(--agent-gui-conversation-actions-width) + 24px);"
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
