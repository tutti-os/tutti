import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "WorkspaceChrome.tsx"),
  "utf8"
);

test("workspace chrome header releases the drag region while the message center is open", () => {
  assert.match(
    source,
    /messageCenterOpen\s*\?\s*"\[-webkit-app-region:no-drag\]"\s*:\s*"\[-webkit-app-region:drag\]"/
  );
  assert.doesNotMatch(source, /min-h-\[52px\][^"]*\[-webkit-app-region:drag\]/);
  assert.match(source, /open=\{messageCenterOpen\}/);
  assert.match(source, /setOpen=\{setMessageCenterOpen\}/);
});

test("workspace chrome deck submit forwards to submitPlanDecision instead of branching on plan action", () => {
  // Must call submitPlanDecision with promptKind threaded from the panel
  assert.match(source, /workspaceAgentActivityService\.submitPlanDecision\(/);
  assert.match(source, /promptKind: input\.promptKind/);

  // Must NOT contain the old plan-implementation branch inside onSubmitPrompt
  assert.doesNotMatch(source, /PLAN_IMPLEMENTATION_ACTION_IMPLEMENT/);
  assert.doesNotMatch(source, /PLAN_IMPLEMENTATION_PROMPT/);
});

test("workspace chrome keeps macOS traffic light left padding at 16px", () => {
  assert.match(
    source,
    /const WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_INSET_PX = 16;/
  );
  assert.match(
    source,
    /const WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_GUTTER_PX = 64;/
  );
  assert.match(
    source,
    /const WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_RESERVED_WIDTH_PX =\s*WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_INSET_PX \+\s*WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_GUTTER_PX;/
  );
  assert.match(
    source,
    /chromeState\.useCompactTitlebar\s*\?\s*`\$\{WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_INSET_PX\}px`/
  );
});

test("workspace chrome active buttons keep mission-control foreground override", () => {
  assert.match(source, /--workbench-chrome-active-foreground/);
  assert.match(
    source,
    /open && "text-\[var\(--workbench-chrome-active-foreground\)\]"/
  );
  assert.match(
    source,
    /settingsState\.open &&\s*"text-\[var\(--workbench-chrome-active-foreground\)\]"/
  );
  assert.match(
    source,
    /active &&\s*"bg-transparency-block text-\[var\(--workbench-chrome-active-foreground\)\]"/
  );
  assert.doesNotMatch(source, /open && "text-foreground"/);
  assert.doesNotMatch(source, /settingsState\.open && "text-foreground"/);
  assert.doesNotMatch(
    source,
    /active && "bg-transparency-block text-foreground"/
  );
});

test("workspace chrome does not call updateSessionSettings or sendInput from the deck submit handler", () => {
  // Ensure the old branching logic in onSubmitPrompt is removed
  // (toast notification path at line 484 uses submitInteractive — that is expected to stay)
  // But updateSessionSettings + sendInput pair for plan mode must be gone from deck handler
  const deckSubmitMatch = source.match(
    /const handleMessageCenterSubmitPrompt = useCallback\(\s*async \(input: \{[\s\S]*?\}\) => \{([\s\S]*?)\},\s*\[workspace\.id, workspaceAgentActivityService\]\s*\)/
  );
  assert.ok(
    deckSubmitMatch,
    "message center submit handler should be present in WorkspaceChrome"
  );
  const handler = deckSubmitMatch[1] ?? "";
  assert.doesNotMatch(handler, /updateSessionSettings/);
  assert.doesNotMatch(handler, /sendInput/);
  assert.doesNotMatch(handler, /submitInteractive/);
  assert.match(source, /onSubmitPrompt=\{handleMessageCenterSubmitPrompt\}/);
});
