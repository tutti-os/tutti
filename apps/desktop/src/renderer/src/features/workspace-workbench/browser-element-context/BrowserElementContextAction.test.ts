import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./BrowserElementContextAction.tsx", import.meta.url),
  "utf8"
);
const browserPanelSource = readFileSync(
  new URL("../ui/StandaloneAgentBrowserToolPanel.tsx", import.meta.url),
  "utf8"
);
const mentionRegistrationSource = readFileSync(
  new URL("./registerDesktopBrowserElementMention.tsx", import.meta.url),
  "utf8"
);
const selectorSource = readFileSync(
  new URL("./browserElementSelectorScript.ts", import.meta.url),
  "utf8"
);

test("browser element selection action uses a shared hover tooltip", () => {
  assert.match(
    source,
    /<TooltipTrigger asChild>[\s\S]*?<Button[\s\S]*?<TooltipContent side="bottom">\{label\}<\/TooltipContent>/
  );
});

test("browser element selection action uses the shared inspect icon", () => {
  assert.match(source, /<InspectIcon className="size-\[15px\]" \/>/);
  assert.doesNotMatch(source, /WebScrapeIcon/);
});

test("standalone browser statically loads the element selection action", () => {
  assert.match(
    browserPanelSource,
    /import \{ BrowserElementContextAction \} from "\.\.\/browser-element-context\/BrowserElementContextAction\.tsx";/u
  );
  assert.doesNotMatch(browserPanelSource, /LazyBrowserElementContextAction/u);
});

test("selected elements append a browser-element mention instead of a file block", () => {
  assert.match(source, /createBrowserElementMentionMarkdown/u);
  assert.match(source, /context: content/u);
  assert.match(source, /onAppendMention\(mention\)/u);
  assert.doesNotMatch(source, /AgentComposerDraftFile/u);
  assert.doesNotMatch(source, /onAppendFile/u);
  assert.doesNotMatch(source, /archiveAgentPromptFile/u);
  assert.doesNotMatch(source, /mimeType:/u);
});

test("browser element mentions use the compact UI System accent badge", () => {
  assert.match(mentionRegistrationSource, /<Badge/u);
  assert.match(mentionRegistrationSource, /variant="accent"/u);
  assert.match(mentionRegistrationSource, /<InspectIcon/u);
  assert.match(mentionRegistrationSource, /data-agent-browser-element-chip/u);
  assert.match(mentionRegistrationSource, /className="h-5[^"]*leading-5"/u);
});

test("browser element selection captures a readable path from the app root", () => {
  assert.match(selectorSource, /document\.querySelector\("#app"\)/u);
  assert.match(selectorSource, /segments\.join\(" > "\)/u);
  assert.match(selectorSource, /return "#app"/u);
  assert.match(selectorSource, /return `\$\{tagName\}\$\{classNames\}`/u);
});

test("browser element selection follows tab switches and guest navigation", () => {
  assert.match(source, /useActiveBrowserNodeWebview/u);
  assert.match(source, /did-start-loading/u);
  assert.match(source, /dom-ready/u);
  assert.match(source, /session\.attempt/u);
  assert.match(
    source,
    /A guest navigation destroys the injected Promise[\s\S]*navigationPending/u
  );
});
