import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./MentionPalette.tsx", import.meta.url), {
  encoding: "utf8"
});
const mentionRowSource = readFileSync(
  new URL("./MentionRow.tsx", import.meta.url),
  {
    encoding: "utf8"
  }
);
const stylesheet = readFileSync(
  new URL("./mentionPalette.css", import.meta.url),
  {
    encoding: "utf8"
  }
);

test("mention palette option backgrounds are driven by highlighted state", () => {
  const rowButton = extractPaletteStyle("rowButton");
  const expandButton = extractPaletteStyle("expandButton");

  assert.equal(rowButton, '"rich-text-at-mention-palette__row-button"');
  assert.doesNotMatch(
    stylesheet,
    /\.rich-text-at-mention-palette__row-button:hover/
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-palette__row-button\[data-highlighted\]/
  );

  assert.equal(expandButton, '"rich-text-at-mention-palette__expand-button"');
  assert.doesNotMatch(
    stylesheet,
    /\.rich-text-at-mention-palette__expand-button:hover/
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-palette__expand-button\[data-highlighted\]/
  );
  assert.doesNotMatch(source, /onMouseEnter=/);
  assert.match(source, /onPointerMove=/);
});

test("mention palette always keeps the package root class for css variables", () => {
  assert.match(
    source,
    /DEFAULT_THEME\.classNames\.palette,[\s\S]*theme\.classNames\.palette,[\s\S]*paletteStyles\.palette/
  );
  assert.doesNotMatch(
    source,
    /className=\{cn\(theme\.classNames\.palette,\s*paletteStyles\.palette\)\}/
  );
});

test("mention palette status tones use ui-system status tokens", () => {
  assert.match(
    stylesheet,
    /--rich-text-at-mention-info-fg:\s*var\(--status-running,/
  );
  assert.match(
    stylesheet,
    /--rich-text-at-mention-warning-fg:\s*var\(--state-warning,/
  );
  assert.doesNotMatch(stylesheet, /--rich-text-at-mention-info-fg:\s*#0369a1/);
  assert.match(
    stylesheet,
    /--rich-text-at-mention-info-bg:\s*color-mix\(\s*in srgb,\s*var\(--rich-text-at-mention-info-fg\) 12%,\s*transparent\s*\)/s
  );
});

test("mention palette scrolls highlighted options inside its own scroll body", () => {
  assert.match(source, /scrollElementIntoScrollContainerNearest/);
  assert.doesNotMatch(
    source,
    /if \(!scrollHighlightedIntoViewCentered\) \{\s*return;\s*\}/
  );
});

test("mention palette content regions use the shell width", () => {
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-palette\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-palette__shell\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-palette__scroll-shell\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-palette__scroll-body\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-palette__empty-state\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-palette__empty-state-inner\s*\{[^}]*width:\s*min\(100%,\s*28ch\);[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-palette__empty-state-text\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/s
  );
});

test("mention palette rows keep trailing controls visible when text is narrow", () => {
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row--app,\s*\.rich-text-at-mention-row--file\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row--issue\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto auto;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row__inline\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row__session-title\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*max-content\) minmax\(0,\s*1fr\);/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row--session\s+\.rich-text-at-mention-row__leading\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\);/s
  );
  assert.match(
    mentionRowSource,
    /rich-text-at-mention-row__text-stack[\s\S]*<\/span>\s*\{item\.statusTag \? \(\s*<MentionStatusBadge/
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row__open-references,\s*\.rich-text-at-mention-row__navigate-into\s*\{[^}]*justify-self:\s*end;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row__open-references\s*\{[^}]*min-width:\s*max-content;[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row__open-references\s*\{[^}]*color:\s*var\(--text-secondary\);/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row__navigate-into\s*\{[^}]*width:\s*24px;[^}]*flex:\s*0 0 24px;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row__app-description\s*\{[^}]*flex:\s*1 1 0;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row__file-text\s*\{[^}]*flex:\s*1 1 0;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row__app-text\s*\{[^}]*flex:\s*1 1 0;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row__description,\s*\.rich-text-at-mention-row__session-summary\s*\{[^}]*flex:\s*1 1 0;/s
  );
  assert.doesNotMatch(
    stylesheet,
    /\.rich-text-at-mention-row__app-name\s*\{[^}]*max-width:/
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-row__file-count\s*\{[^}]*flex:\s*0 0 auto;/s
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-status\s*\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/s
  );
  assert.doesNotMatch(
    stylesheet,
    /\.rich-text-at-mention-status\s*\{[^}]*max-width:/s
  );
});

function extractPaletteStyle(name: string): string {
  const match = source.match(new RegExp(`${name}:\\s*(".*?")`, "s"));
  assert.ok(match?.[1], `Expected ${name} style to stay a string literal.`);
  return match[1];
}
