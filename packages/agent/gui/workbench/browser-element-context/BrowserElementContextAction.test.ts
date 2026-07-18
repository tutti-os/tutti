import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "workbench/browser-element-context/BrowserElementContextAction.tsx",
  "utf8"
);
const controllerSource = readFileSync(
  "workbench/browser-element-context/browserElementContextSelectionController.ts",
  "utf8"
);
const selectionSource = `${source}\n${controllerSource}`;
const mentionRegistrationSource = readFileSync(
  "workbench/browser-element-context/registerBrowserElementMention.tsx",
  "utf8"
);
const selectorSource = readFileSync(
  "workbench/browser-element-context/browserElementSelectorScript.ts",
  "utf8"
);

describe("BrowserElementContextAction", () => {
  it("uses a shared hover tooltip", () => {
    expect(source).toMatch(
      /<TooltipTrigger asChild>[\s\S]*?<Button[\s\S]*?<TooltipContent side="bottom">\{label\}<\/TooltipContent>/
    );
  });

  it("uses the shared inspect icon", () => {
    expect(source).toMatch(/<InspectIcon className="size-\[15px\]" \/>/);
    expect(source).not.toMatch(/WebScrapeIcon/);
  });

  it("appends a browser-element mention instead of a file block", () => {
    expect(selectionSource).toMatch(/createBrowserElementMentionMarkdown/u);
    expect(selectionSource).toMatch(/context: content/u);
    expect(selectionSource).toMatch(/onAppendMention\(mention\)/u);
    expect(selectionSource).not.toMatch(/AgentComposerDraftFile/u);
    expect(selectionSource).not.toMatch(/onAppendFile/u);
    expect(selectionSource).not.toMatch(/archiveAgentPromptFile/u);
    expect(selectionSource).not.toMatch(/mimeType:/u);
  });

  it("renders mentions with the compact UI System accent badge", () => {
    expect(mentionRegistrationSource).toMatch(/<Badge/u);
    expect(mentionRegistrationSource).toMatch(/variant="accent"/u);
    expect(mentionRegistrationSource).toMatch(/<InspectIcon/u);
    expect(mentionRegistrationSource).toMatch(
      /data-agent-browser-element-chip/u
    );
    expect(mentionRegistrationSource).toMatch(/className="h-5[^"]*leading-5"/u);
  });

  it("captures a readable path from the app root", () => {
    expect(selectorSource).toMatch(/document\.querySelector\("#app"\)/u);
    expect(selectorSource).toMatch(/segments\.join\(" > "\)/u);
    expect(selectorSource).toMatch(/return "#app"/u);
    expect(selectorSource).toMatch(/return `\$\{tagName\}\$\{classNames\}`/u);
  });

  it("follows tab switches and guest navigation", () => {
    expect(source).toMatch(/useActiveBrowserNodeWebview/u);
    expect(selectionSource).toMatch(/did-start-loading/u);
    expect(selectionSource).toMatch(/dom-ready/u);
    expect(selectionSource).toMatch(/session\.attempt/u);
    expect(selectionSource).toMatch(
      /A guest navigation destroys the injected Promise[\s\S]*navigationPending/u
    );
  });
});
