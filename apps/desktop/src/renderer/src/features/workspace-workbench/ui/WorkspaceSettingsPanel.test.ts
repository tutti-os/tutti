import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "WorkspaceSettingsPanel.tsx"
  ),
  "utf8"
);

test("workspace settings developer panel exposes analytics debug switch only when available", () => {
  assert.match(source, /useAnalyticsDebugPreferenceService/);
  assert.match(source, /analyticsDebugAvailable \? \(/);
  assert.match(source, /<Switch\s/s);
  assert.match(source, /checked=\{analyticsDebugEnabled\}/);
  assert.match(source, /onCheckedChange=\{onAnalyticsDebugEnabledChange\}/);
});

test("workspace settings panel lists appearance below general", () => {
  assert.match(
    source,
    /id: "general" as const,[\s\S]*id: "agent" as const,[\s\S]*id: "appearance" as const,[\s\S]*id: "apps" as const,[\s\S]*id: "about" as const,[\s\S]*id: "developer" as const/
  );
});

test("workspace settings backdrop preserves titlebar dragging", () => {
  assert.match(source, /data-workspace-settings-backdrop="true"/);
  assert.match(source, /bg-\[var\(--backdrop\)\]/);
  assert.doesNotMatch(source, /var\(--backdrop\)_28%/);
  assert.match(source, /data-workspace-settings-window-drag-region="true"/);
  assert.match(
    source,
    /pointer-events-auto absolute inset-x-0 top-0 z-0 h-\[52px\] \[-webkit-app-region:drag\]/
  );
  assert.match(source, /data-workspace-settings-panel="true"/);
  assert.match(source, /\[-webkit-app-region:no-drag\]/);
});

test("workspace settings agent panel lists agent controls", () => {
  assert.match(
    source,
    /function WorkspaceAgentSettingsSection[\s\S]*workspace\.settings\.general\.agentConversationDetailModeLabel[\s\S]*workspace\.externalImport\.settingsLabel[\s\S]*workspace\.settings\.general\.defaultAgentProviderLabel[\s\S]*workspace\.settings\.general\.browserUseConnectionModeLabel[\s\S]*<ComputerUseSetupRow/
  );
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /role="radio"/);
  assert.match(source, /aria-checked=\{selected\}/);
  assert.match(source, /desktopAgentConversationDetailModes\.map/);
  assert.match(source, /onAgentConversationDetailModeChange\(mode\)/);
});

test("workspace settings work mode selected state uses a tutti purple border", () => {
  assert.match(
    source,
    /selected\s*\?\s*"border border-\[var\(--tutti-purple\)\] bg-\[var\(--background-fronted\)\]/
  );
});

test("workspace settings general panel lists system controls", () => {
  assert.match(
    source,
    /function WorkspaceGeneralSettingsSection[\s\S]*workspace\.settings\.general\.preventSleepLabel[\s\S]*workspace\.settings\.general\.languageLabel/
  );
});

test("workspace settings default provider only offers Codex and Claude Code", () => {
  assert.match(
    source,
    /const workspaceSettingsDefaultAgentProviders = \[\s*"codex",\s*"claude-code"\s*\]/
  );
  assert.match(
    source,
    /workspaceSettingsDefaultAgentProviders\.map\(\(provider\) => \([\s\S]*<SelectItem key=\{provider\} value=\{provider\}>/
  );
  assert.doesNotMatch(
    source,
    /workspaceAgentGuiProviders\.map\(\(provider\) => \([\s\S]*<SelectItem key=\{provider\} value=\{provider\}>/
  );
});

test("workspace settings agent panel owns browser-use connection mode", () => {
  assert.match(
    source,
    /function WorkspaceAgentSettingsSection[\s\S]*workspace\.settings\.general\.browserUseConnectionModeLabel[\s\S]*workspace\.settings\.general\.browserUseConnectionModeOptions\.autoConnect[\s\S]*<ComputerUseSetupRow/
  );
  assert.match(source, /changeBrowserUseConnectionMode/);
});

test("workspace settings computer-use permission hints are tooltips", () => {
  assert.match(source, /resolveComputerUseGrantTooltip/);
  assert.match(source, /<TooltipTrigger asChild>/);
  assert.match(
    source,
    /workspace\.settings\.general\.computerUsePermissionMissingTooltip/
  );
});

test("workspace settings general panel does not expose update preferences", () => {
  assert.doesNotMatch(source, /WorkspaceUpdateSettingsSection/);
  assert.doesNotMatch(source, /workspace\.settings\.general\.updateTitle/);
  assert.doesNotMatch(
    source,
    /workspace\.settings\.general\.updatePolicyLabel/
  );
  assert.doesNotMatch(
    source,
    /workspace\.settings\.general\.updateChannelLabel/
  );
  assert.doesNotMatch(source, /onUpdatePolicyChange/);
  assert.doesNotMatch(source, /onUpdateChannelChange/);
  assert.doesNotMatch(source, /app_update\.settings_rendered/);
});

test("workspace settings about card keeps version pill compact", () => {
  assert.match(
    source,
    /inline-flex h-7 shrink-0 cursor-default select-none items-center gap-1 rounded-full[\s\S]*font-mono text-\[13px\] leading-5/
  );
  assert.doesNotMatch(
    source,
    /inline-flex h-7 shrink-0 cursor-default select-none items-center gap-1 rounded-full[^\n]*hover:/
  );
  assert.match(
    source,
    /flex w-full flex-col gap-4 px-5 pb-5 pt-7[\s\S]*items-center justify-between gap-4/
  );
});

test("workspace settings about panel owns product info and keeps developer unlock tap", () => {
  const generalSectionStart = source.indexOf(
    "function WorkspaceGeneralSettingsSection"
  );
  const aboutSectionStart = source.indexOf(
    "function WorkspaceAboutSettingsSection"
  );
  const appearanceSectionStart = source.indexOf(
    "function WorkspaceAppearanceSettingsSection"
  );

  assert.ok(generalSectionStart >= 0);
  assert.ok(aboutSectionStart > generalSectionStart);
  assert.ok(appearanceSectionStart > aboutSectionStart);
  assert.doesNotMatch(
    source.slice(generalSectionStart, aboutSectionStart),
    /versionLabel/
  );
  assert.match(
    source.slice(aboutSectionStart, appearanceSectionStart),
    /tuttiDesktopIconUrl[\s\S]*onClick=\{onVersionTap\}[\s\S]*workspace\.settings\.about\.versionLabel/
  );
  assert.doesNotMatch(
    source.slice(aboutSectionStart, appearanceSectionStart),
    /workspace\.settings\.about\.(title|description)/
  );
  assert.match(
    source,
    /setDeveloperPanelVisible\(true\);[\s\S]*notifications\.success\(\{[\s\S]*workspace\.settings\.about\.developerModeEnabled/
  );
  assert.doesNotMatch(source, /selectSection\("developer"\)/);
  assert.match(
    source,
    /const tuttiDesktopIconUrl = new URL\(\s*"[^"]*build\/icon\.png"/
  );
  assert.match(
    source.slice(aboutSectionStart, appearanceSectionStart),
    /WebIcon[\s\S]*openExternal\(tuttiWebsiteUrl\)[\s\S]*GitHubBrandIcon[\s\S]*openExternal\(tuttiGitHubUrl\)/
  );
  assert.doesNotMatch(
    source.slice(aboutSectionStart, appearanceSectionStart),
    /releaseNotesAction|checkForUpdates|checkUpdatesAction/
  );
});

test("workspace settings appearance panel owns visual settings", () => {
  assert.match(source, /WorkspaceAppearanceSettingsSection/);
  assert.match(source, /workspace\.settings\.appearance\.themeLabel/);
  assert.match(source, /workspace\.settings\.appearance\.dockPlacementLabel/);
  assert.match(source, /workspace\.settings\.appearance\.wallpaperLabel/);
});

test("workspace settings window snapping is controlled by one dropdown", () => {
  const appearanceSectionStart = source.indexOf(
    "function WorkspaceAppearanceSettingsSection"
  );
  const wallpaperPickerStart = source.indexOf(
    "function WorkspaceWallpaperPicker"
  );
  const appearanceSection = source.slice(
    appearanceSectionStart,
    wallpaperPickerStart
  );

  assert.ok(appearanceSectionStart >= 0);
  assert.ok(wallpaperPickerStart > appearanceSectionStart);
  assert.doesNotMatch(appearanceSection, /<Switch/);
  assert.match(
    appearanceSection,
    /pendingWorkbenchWindowSnapping\.enabled[\s\S]*\? pendingWorkbenchWindowSnapping\.shortcutPreset[\s\S]*: "off"/
  );
  assert.match(appearanceSection, /enabled: nextValue !== "off"/);
  assert.match(
    appearanceSection,
    /workbenchWindowSnappingShortcutOptions\.off/
  );
});

test("workspace settings app source control lives in developer settings", () => {
  const appsSectionStart = source.indexOf(
    "function WorkspaceAppsSettingsSection"
  );
  const developerSectionStart = source.indexOf(
    "function WorkspaceDeveloperSettingsSection"
  );
  const controlStart = source.indexOf("function AppCatalogChannelControl");

  assert.ok(appsSectionStart >= 0);
  assert.ok(developerSectionStart > appsSectionStart);
  assert.ok(controlStart > developerSectionStart);
  assert.doesNotMatch(
    source.slice(appsSectionStart, developerSectionStart),
    /appCatalogChannel/
  );
  assert.match(
    source.slice(developerSectionStart, controlStart),
    /<AppCatalogChannelControl/
  );
});

test("workspace managed provider API key is masked until toggled visible", () => {
  assert.match(source, /type=\{apiKeyVisible \? "text" : "password"\}/);
  assert.match(source, /setVisibleAPIKeyProviderID/);
  assert.match(source, /workspace\.settings\.apps\.managedModels\.showApiKey/);
  assert.match(source, /workspace\.settings\.apps\.managedModels\.hideApiKey/);
});

test("workspace managed provider models use compact rows instead of a textarea", () => {
  assert.match(source, /models\.map\(\(model, index\)/);
  assert.match(source, /grid-cols-\[max-content_minmax\(0,1fr\)_32px\]/);
  assert.match(source, /workspaceManagedModelInputClass/);
  assert.match(source, /focus-visible:!border-\[var\(--border-1\)\]/);
  assert.match(source, /h-px w-full bg-\[var\(--border-1\)\]/);
  assert.match(source, /setPendingFocusModelIndex\(nextIndex\)/);
  assert.match(source, /\{ id: "", name: "", provider: draft\.provider \}/);
  assert.match(
    source,
    /className="flex flex-wrap items-center justify-between gap-2"/
  );
  assert.match(source, /<Button[^>]*variant="ghost"[^>]*onClick=\{addModel\}/);
  assert.match(source, /className="flex flex-wrap justify-end gap-2"/);
  assert.doesNotMatch(
    source,
    /<Button[^>]*variant="secondary"[^>]*onClick=\{addModel\}/
  );
  assert.doesNotMatch(source, /grid-cols-\[72px_minmax\(0,1fr\)_/);
  assert.doesNotMatch(source, /newModelID/);
  assert.doesNotMatch(source, /modelsText/);
});
