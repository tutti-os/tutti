import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(process.cwd(), "app/renderer/agentactivity.css"),
  "utf8"
);
const queuedMentionStylesStart = css.indexOf(
  ".agent-gui-node__composer-queued-prompt-markdown"
);
const queuedMentionStyles = css.slice(
  queuedMentionStylesStart,
  css.indexOf(
    '.agent-gui-node__composer-queued-prompt-panel[data-expanded="true"]',
    queuedMentionStylesStart
  )
);

describe("AgentQueuedPromptPanel CSS composition", () => {
  it("keeps mention pill icons visible while hiding standalone media", () => {
    const mediaSelector =
      ':is(img, video, table, hr, br, input):not([data-slot="mention-pill"] *)';
    expect(queuedMentionStyles).toMatch(
      /:is\(img, video, table, hr, br, input\):not\(\[data-slot="mention-pill"\] \*\)\s*\{[^}]*display:\s*none;/s
    );
    expect(queuedMentionStyles).not.toMatch(
      /:is\(img, video, table, hr, br, input\)\s*\{[^}]*display:\s*none;/s
    );

    const mentionPill = document.createElement("span");
    mentionPill.dataset.slot = "mention-pill";
    const mentionIcon = document.createElement("img");
    const standaloneImage = document.createElement("img");
    mentionPill.append(mentionIcon);
    document.body.append(mentionPill, standaloneImage);

    expect(mentionIcon.matches(mediaSelector)).toBe(false);
    expect(standaloneImage.matches(mediaSelector)).toBe(true);
    mentionPill.remove();
    standaloneImage.remove();
  });

  it("keeps the entity link layout-only around the shared mention pill", () => {
    expect(queuedMentionStyles).toMatch(
      /\[data-agent-file-mention="true"\]\.tsh-agent-object-token--entity\s*\{[^}]*top:\s*0;[^}]*gap:\s*0;[^}]*min-height:\s*0;[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*line-height:\s*inherit;/s
    );
    expect(queuedMentionStyles).not.toMatch(
      /\[data-agent-file-mention="true"\]\.tsh-agent-object-token--entity\s*\{[^}]*padding:\s*2px 4px;/s
    );
  });

  it("vertically aligns file mentions, entity wrappers, and mention pills", () => {
    expect(queuedMentionStyles).toMatch(
      /\.tsh-agent-object-token--file,\s*\.agent-gui-node__composer-queued-prompt-markdown\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token--entity\s*> \[data-slot="mention-pill"\]\s*\{[^}]*top:\s*0;[^}]*vertical-align:\s*middle;/s
    );
  });
});
