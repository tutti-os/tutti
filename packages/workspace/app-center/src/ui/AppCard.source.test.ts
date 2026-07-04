import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./AppCard.tsx", import.meta.url), "utf8");

test("App Card primary action label stays inside the card header", () => {
  assert.match(
    source,
    /className="flex min-w-0 flex-1 items-center justify-end gap-1"/
  );
  assert.match(source, /"min-w-0 max-w-full shrink truncate px-2"/);
  assert.match(source, /title=\{primaryActionTitle\}/);
});

test("App Card developer source row has breathing room below the app description", () => {
  assert.match(source, /className="mt-auto min-w-0 pt-3"/);
  assert.match(source, /className="group\/source flex min-h-7/);
});

test("App Card truncated name and description expose full text in hover tooltips", () => {
  assert.match(source, /function AppCardTextTooltip/);
  assert.match(source, /element\.scrollWidth - element\.clientWidth > 1/);
  assert.match(source, /element\.scrollHeight - element\.clientHeight > 1/);
  assert.match(
    source,
    /<TooltipTrigger asChild>\{textElement\}<\/TooltipTrigger>/
  );
  assert.match(source, /overflowing \? \(/);
  assert.match(source, /content=\{app\.name\}/);
  assert.match(source, /content=\{app\.description\}/);
  assert.match(
    source,
    /max-w-\[min\(420px,calc\(100vw-32px\)\)\] whitespace-normal text-left \[overflow-wrap:anywhere\]/
  );
});

test("official app authors fall back to the configured developer icon instead of a letter avatar", () => {
  assert.match(
    source,
    /fallbackIconUrl=\{official \? officialDeveloperIconUrl : null\}/
  );
  assert.match(source, /className="size-5 shrink-0 rounded-\[5px\]/);
});

test("developer source popup opens on hover instead of requiring a click", () => {
  assert.match(
    source,
    /<Popover open=\{popoverOpen\} onOpenChange=\{setPopoverOpen\}>/
  );
  assert.match(source, /onPointerEnter=\{openPopover\}/);
  assert.match(source, /onPointerLeave=\{scheduleClosePopover\}/);
  assert.match(source, /onOpenAutoFocus=\{\(event\) => \{/);
  assert.match(source, /onCloseAutoFocus=\{\(event\) => \{/);
  assert.doesNotMatch(source, /onFocus=\{openPopover\}/);
  assert.doesNotMatch(source, /onBlur=\{scheduleClosePopover\}/);
});

test("bundled apps without source metadata still show the official source row", () => {
  assert.match(source, /app\.sourceKind === "bundled"/);
  assert.match(source, /\? \[\{ name: "Tutti" \}\]/);
});

test("community app developer action appears before other more-menu actions", () => {
  const developerIndex = source.indexOf('key: "developer"');
  const openFolderIndex = source.indexOf('key: "open-folder"');
  assert.notEqual(developerIndex, -1);
  assert.notEqual(openFolderIndex, -1);
  assert.equal(developerIndex < openFolderIndex, true);
  assert.match(source, /isCommunityRecommendedApp\(app\.id\)/);
  assert.match(source, /copy\.t\("sources\.developerMenuLabel"/);
  assert.match(source, /<AuthorAvatar author=\{communityDeveloper\} \/>/);
  assert.match(source, /openExternalURL\(actions, communityDeveloper\.url\)/);
});

test("developer source links prefer the host external URL opener", () => {
  assert.match(source, /readonly openExternalUrl\?: \(url: string\)/);
  assert.match(source, /openExternalURL\(actions, author\.url\)/);
  assert.match(source, /openExternalURL\(actions, repository\.url\)/);
  assert.match(source, /actions\.openExternalUrl\(target\)/);
});
