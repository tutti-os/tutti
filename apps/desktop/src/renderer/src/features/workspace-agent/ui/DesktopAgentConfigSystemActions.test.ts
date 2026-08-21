import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { shouldShowDesktopAgentConfigSystemActions } from "./desktopAgentConfigSystemActionsModel.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(directory, "DesktopAgentConfigSystemActions.tsx"),
  "utf8"
);
const workbenchSource = readFileSync(
  resolve(directory, "DesktopAgentGUIWorkbenchBody.tsx"),
  "utf8"
);

test("Agent config system actions stay hidden in OS mode", () => {
  assert.match(workbenchSource, /resolveDesktopWorkspaceUiMode\(/);
  assert.equal(shouldShowDesktopAgentConfigSystemActions("os"), false);
  assert.equal(shouldShowDesktopAgentConfigSystemActions("agent"), true);
  assert.match(
    workbenchSource,
    /shouldShowDesktopAgentConfigSystemActions\(\s*workspaceUiMode\s*\)/
  );
  assert.match(
    workbenchSource,
    /\? renderDesktopAgentConfigSystemActions\s+: undefined/
  );
});

test("Agent config log export uses the ui-system native submenu", () => {
  assert.match(source, /<DropdownMenuSub>/);
  assert.match(source, /<DropdownMenuSubTrigger[\s\S]*exportLogs/);
  assert.match(
    source,
    /<DropdownMenuSubContent[\s\S]*zIndex: "calc\(var\(--z-panel-popover\) \+ 1\)"/
  );
  assert.match(
    source,
    /className="nodrag w-64 \[-webkit-app-region:no-drag\]"/
  );
  assert.match(source, /sideOffset=\{4\}/);
  assert.equal(source.match(/<DropdownMenuItem/g)?.length, 5);
  assert.equal(source.match(/onSelect=/g)?.length, 5);
  assert.doesNotMatch(source, /onClick=/);
  assert.doesNotMatch(source, /onPointer(?:Enter|Leave|Down)=/);
  assert.doesNotMatch(source, /exportMenuOpen|owned-layer|GraceClose/);
});
