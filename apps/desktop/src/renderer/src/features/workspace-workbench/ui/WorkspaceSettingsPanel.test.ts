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
const developerSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "WorkspaceDeveloperSettingsSection.tsx"
  ),
  "utf8"
);
const defaultProvidersSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "workspaceSettingsDefaultAgentProviders.ts"
  ),
  "utf8"
);

test("workspace settings developer panel exposes analytics debug switch only when available", () => {
  assert.match(developerSource, /useAnalyticsDebugPreferenceService/);
  assert.match(developerSource, /analyticsDebugAvailable \? \(/);
  assert.match(developerSource, /<Switch\s/s);
  assert.match(developerSource, /checked=\{analyticsDebugEnabled\}/);
  assert.match(
    developerSource,
    /onCheckedChange=\{onAnalyticsDebugEnabledChange\}/
  );
});

test("workspace settings gates account behind Tutti Agent Switch", () => {
  assert.match(source, /settingsState\.tuttiAgentSwitchEnabled/);
  assert.match(
    developerSource,
    /workspace\.settings\.developer\.tuttiAgentSwitchLabel/
  );
  assert.match(
    developerSource,
    /settingsService\.setTuttiAgentSwitchEnabled\(enabled\)/
  );
  assert.match(source, /settingsState\.activeSection === "account"/);
  assert.match(source, /<WorkspaceAccountSettingsSection \/>/);
});

test("workspace settings forwards workspace mode and sleep prevention changes", () => {
  assert.match(
    source,
    /onSleepPreventionModeChange=\{\(mode\) => \{\s+void settingsService\.changeSleepPreventionMode\(mode\)/
  );
  assert.match(
    source,
    /onWorkspaceUiModeChange=\{\(mode\) => \{\s+void settingsService\.changeWorkspaceUiMode\(mode\)/
  );
});

test("workspace settings requires the exact destructive confirmation before cleanup", () => {
  assert.match(source, /deletedAgentConversationRetentionDaysOptions/);
  assert.match(source, /settingsService\.purgeDeletedConversations\(\)/);
  assert.match(
    source,
    /purgeConfirmation !== purgeConfirmationPhrase[\s\S]{0,300}variant="destructive"/
  );
  assert.match(source, /deletedConversationPurgeConfirmationPhrase/);
  assert.match(
    source,
    /size="icon"[\s\S]{0,120}variant="destructive-secondary"/
  );
  assert.doesNotMatch(source, /var\(--z-modal\)/);
});

test("workspace settings unlocks developer mode after seven version taps", () => {
  assert.match(source, /const developerPanelUnlockTaps = 7/);
  assert.match(
    source,
    /versionTapCountRef\.current \+= 1;\s+if \(versionTapCountRef\.current >= developerPanelUnlockTaps\) \{\s+versionTapCountRef\.current = 0;\s+settingsService\.setDeveloperPanelVisible\(true\);\s+notifications\.success\(\{\s+title: t\("workspace\.settings\.about\.developerModeEnabled"\)/
  );
  assert.match(source, /onVersionTap=\{handleVersionTap\}/);
});

test("workspace settings maps snapping off and presets without losing the preset", () => {
  assert.match(
    source,
    /pendingWorkbenchWindowSnapping\.enabled\s+\? pendingWorkbenchWindowSnapping\.shortcutPreset\s+: "off"/
  );
  assert.match(
    source,
    /enabled: nextValue !== "off",\s+shortcutPreset:\s+nextValue === "off"\s+\? pendingWorkbenchWindowSnapping\.shortcutPreset\s+: nextValue/
  );
});

test("workspace settings default providers come from the provider descriptor catalog", () => {
  assert.match(
    defaultProvidersSource,
    /migratedAgentGUIProviderIdentityCatalog[\s\S]*entry\.desktop\.defaultProviderEligible[\s\S]*defaultProviderPriority/
  );
  assert.doesNotMatch(defaultProvidersSource, /\[\s*"codex",\s*"claude-code"/);
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

test("workspace settings computer-use tooltip and polling stay wired", () => {
  assert.match(source, /resolveComputerUseGrantTooltip/);
  assert.match(source, /resolveComputerUseGrantStep/);
  assert.match(source, /<TooltipTrigger asChild>/);
  assert.match(
    source,
    /workspace\.settings\.general\.computerUsePermissionMissingTooltip/
  );
  assert.match(source, /openComputerUsePermissionSettings/);
  assert.match(source, /computerUseAutoCheckIntervalMs/);
  assert.match(source, /setAutoCheckActive\(true\)/);
  assert.match(source, /logComputerUsePermissionDiagnostic/);
  assert.match(source, /computer_use\.permission_status_checked/);
  assert.match(source, /computer_use\.permission_dialog_open_changed/);
});

test("workspace settings computer-use verify reconciles unconditionally", () => {
  const verifyStart = source.indexOf(
    "const handleWizardVerify = async () => {"
  );
  const verifyEnd = source.indexOf("useEffect(() => {", verifyStart);
  assert.ok(verifyStart >= 0);
  const verifySource = source.slice(verifyStart, verifyEnd);
  // Verify never trusts a prior status read: it always restarts the daemon
  // (clearing AX cache, capture freeze, and a killed daemon at once) and only
  // then reads the state — forced past any still-confirming grant.
  assert.match(verifySource, /restartComputerUseDriver\(\{ force: true \}\)/);
  assert.match(verifySource, /\} catch \{/);
  assert.match(
    verifySource,
    /workspace\.settings\.general\.computerUseStatusCheckFailed/
  );
  assert.match(verifySource, /setLastCheckedAtUnixMs\(Date\.now\(\)\)/);
  assert.match(verifySource, /setWizardStep\("done"\)/);
  assert.match(verifySource, /computer_use\.wizard_verify_clicked/);
  assert.match(verifySource, /computer_use\.wizard_verify_resolved/);
});

test("workspace settings computer-use status checks keep prior state on failure", () => {
  const checkStatusStart = source.indexOf("const checkStatus = useCallback(");
  const startAutoCheckStart = source.indexOf(
    "const startAutoCheck = useCallback(",
    checkStatusStart
  );
  assert.ok(checkStatusStart >= 0);
  const checkStatusSource = source.slice(checkStatusStart, startAutoCheckStart);
  assert.doesNotMatch(checkStatusSource, /reason: "not-installed"/);
  assert.match(checkStatusSource, /lastKnownStatusRef/);
  assert.match(checkStatusSource, /"check-failed"/);
  // The last-checked timestamp only moves on explicit user actions — the
  // 1.5s auto-poll must not turn it into a ticking clock.
  assert.doesNotMatch(checkStatusSource, /setLastCheckedAtUnixMs/);
  assert.match(checkStatusSource, /return null;/);
});

test("workspace settings computer-use refreshes on window focus and dialog open", () => {
  assert.match(source, /computerUseFocusRefreshMinIntervalMs/);
  assert.match(
    source,
    /window\.addEventListener\("focus", refreshOnVisibility\)/
  );
  assert.match(
    source,
    /document\.addEventListener\("visibilitychange", refreshOnVisibility\)/
  );
  assert.match(source, /diagnosticTrigger: "window-focus"/);
  assert.match(source, /diagnosticTrigger: "dialog-opened"/);
});

test("workspace settings computer-use wizard walks five user-driven steps", () => {
  // The wizard is user-driven and linear; status only assists (chips and the
  // initial step guess) and never gates navigation.
  assert.match(source, /function ComputerUseSetupWizardDialog/);
  assert.match(
    source,
    /const computerUseWizardStepOrder[\s\S]{0,200}"install",\s*"accessibility",\s*"screen-recording",\s*"verify",\s*"done"/
  );
  assert.match(source, /function resolveComputerUseWizardInitialStep/);
  assert.match(source, /workspace\.settings\.general\.computerUseWizardBack/);
  assert.match(source, /workspace\.settings\.general\.computerUseWizardNext/);
  assert.match(
    source,
    /workspace\.settings\.general\.computerUseWizardGrantInstruction/
  );
  assert.match(
    source,
    /workspace\.settings\.general\.computerUseWizardScreenRecordingKillNote/
  );
  assert.match(source, /workspace\.settings\.general\.computerUseDoneButton/);
  assert.match(
    source,
    /workspace\.settings\.general\.computerUseLastCheckedAt/
  );
  // Both grant steps reuse the same toggle demo — the two System Settings
  // panes look identical.
  assert.match(source, /cua-driver-toggle-demo\.gif/);
  assert.match(source, /src=\{cuaDriverToggleDemoUrl\}/);
  assert.match(source, /onOpenSettings\(grantPane\)/);
  assert.match(source, /function ComputerUsePermissionStatusRow/);
  assert.match(source, /<StatusDot/);
  // The collapsed row escalates via the manage button (pulsing amber dot +
  // tooltip), not a standing hint paragraph.
  assert.match(source, /computerUseNeedsAttention/);
  assert.match(
    source,
    /computerUseNeedsAttention && \(\s*<StatusDot\s*className="absolute -right-0\.5 -top-0\.5/
  );
  // The "why CuaDriver" explanation stays a hover tooltip on the "?" next to
  // the dialog title.
  assert.match(
    source,
    /<AskLinedIcon[\s\S]{0,600}computerUsePermissionDialogRelationshipBody/
  );
  assert.match(
    source,
    /<DialogDescription className="sr-only">[\s\S]{0,200}computerUsePermissionDialogDescription/
  );
  // Operation-centric checklist-era logic must stay gone.
  assert.doesNotMatch(source, /primaryActionChecksStatus/);
  assert.doesNotMatch(source, /startPermissionGrantFlow/);
  assert.doesNotMatch(source, /grantFallbackVisible/);
  assert.doesNotMatch(source, /dialogAutoRecoverAttemptedReasonRef/);
});

test("workspace settings computer-use grant fires only behind the settings click", () => {
  // The grant CLI's only wizard job is registering CuaDriver in the privacy
  // panes / raising the TCC prompt — and it may open windows of its own, so
  // it must run only behind the user's explicit "Open Settings" click, never
  // on step entry, and it is never awaited.
  assert.match(source, /wizardGrantFiredRef/);
  assert.match(
    source,
    /computer_use\.permission_settings_open_clicked[\s\S]{0,900}void settingsService\s*\.startComputerUsePermissionGrant\(\)\s*\.catch\(\(\) => undefined\);/
  );
  assert.match(source, /computer_use\.wizard_grant_fired/);
  assert.doesNotMatch(
    source,
    /await settingsService\.startComputerUsePermissionGrant/
  );
});

test("workspace settings computer-use continues into the wizard after install", () => {
  assert.match(
    source,
    /diagnosticTrigger: "install-completed"[\s\S]{0,900}setWizardStep\("accessibility"\);\s*setPermissionDialogOpen\(true\);\s*startAutoCheck\(\);/
  );
});

test("workspace managed provider API key is masked until toggled visible", () => {
  assert.match(source, /type=\{apiKeyVisible \? "text" : "password"\}/);
  assert.match(source, /setVisibleAPIKeyProviderID/);
  assert.match(source, /workspace\.settings\.apps\.managedModels\.showApiKey/);
  assert.match(source, /workspace\.settings\.apps\.managedModels\.hideApiKey/);
});

test("workspace managed provider model rows keep stable keys while editing", () => {
  assert.match(source, /key=\{`\$\{model\.provider\}:\$\{index\}`\}/);
  assert.doesNotMatch(
    source,
    /key=\{`\$\{model\.provider\}:\$\{model\.id\}:\$\{index\}`\}/
  );
});
