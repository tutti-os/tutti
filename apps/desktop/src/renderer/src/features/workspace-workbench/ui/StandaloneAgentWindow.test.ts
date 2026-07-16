import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const standaloneWindowSource = readFileSync(
  resolve(currentDirectory, "StandaloneAgentWindow.tsx"),
  "utf8"
);
const standaloneWindowPanelHostsSource = readFileSync(
  resolve(currentDirectory, "StandaloneAgentWindowPanelHosts.tsx"),
  "utf8"
);
const standaloneHeaderIdentitySource = readFileSync(
  resolve(currentDirectory, "standaloneAgentHeaderIdentity.ts"),
  "utf8"
);
const standaloneWindowHeaderSource = readFileSync(
  resolve(currentDirectory, "StandaloneAgentWindowHeader.tsx"),
  "utf8"
);
const standaloneLaunchRoutingSource = readFileSync(
  resolve(currentDirectory, "useStandaloneAgentLaunchRouting.ts"),
  "utf8"
);
const workbenchBodySource = readFileSync(
  resolve(
    currentDirectory,
    "../../workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx"
  ),
  "utf8"
);

test("standalone Agent reuses the OS account menu in the sidebar footer", () => {
  assert.match(
    standaloneWindowSource,
    /import\("\.\/WorkspaceAccountMenu"\)[\s\S]*?default: WorkspaceAccountMenu/
  );
  assert.match(
    standaloneWindowSource,
    /function renderStandaloneAgentSidebarFooter\(\): ReactNode \{[\s\S]*<LazyWorkspaceAccountMenu \/>/
  );
  assert.match(
    standaloneWindowSource,
    /renderSidebarFooter=\{renderStandaloneAgentSidebarFooter\}/
  );
  assert.match(
    workbenchBodySource,
    /renderSlots=\{\{[\s\S]*sidebarFooter: previewMode \? undefined : renderSidebarFooter[\s\S]*\}\}/
  );
});

test("standalone Agent defers non-critical panel hosts until after the first frame", () => {
  assert.match(
    standaloneWindowSource,
    /window\.requestAnimationFrame\(\(\) => \{\s*setPanelHostsReady\(true\)/
  );
  assert.match(
    standaloneWindowSource,
    /panelHostsReady \? \([\s\S]*?<LazyStandaloneAgentWindowPanelHosts/
  );
});

test("standalone Agent delegates live window focus to the engagement controller", () => {
  assert.match(standaloneWindowSource, /isFocused: true/);
  assert.doesNotMatch(
    standaloneWindowSource,
    /isFocused: document\.hasFocus\(\)/
  );
});

test("standalone Agent accepts a startup intent without a provider", () => {
  assert.match(
    standaloneWindowSource,
    /windowIntent\.kind === "agent" && windowIntent\.provider\s*\? normalizeDesktopAgentGUIProvider\(windowIntent\.provider\)\s*: "codex"/
  );
});

test("standalone Agent starts the app runtime lifecycle only when apps open", () => {
  assert.match(
    standaloneWindowSource,
    /const ensureWorkspaceAppPolling = useCallback\([\s\S]*?startWorkspacePolling\(workspaceId\)/
  );
  assert.match(
    standaloneWindowSource,
    /onAppsOpen=\{ensureWorkspaceAppPolling\}/
  );
  assert.match(
    standaloneWindowSource,
    /workspaceAppSurfaceHost\.registerPresenter\([\s\S]*?createStandaloneAgentWorkspaceAppSurfacePresenter\([\s\S]*?ensureWorkspaceAppPolling/
  );
});

test("standalone Agent opens files like Finder and routes links into the right sidebar", () => {
  assert.match(
    standaloneWindowSource,
    /workspaceFilePreviewSurfaceHost\.registerPresenter\([\s\S]*?createStandaloneAgentWorkspaceFilePreviewPresenter\([\s\S]*?hostFilesApi: desktopApi\.host\.files/
  );
  assert.match(standaloneWindowSource, /workspaceFilePreviewMode: "canvas"/);
  assert.match(
    standaloneLaunchRoutingSource,
    /runDesktopAgentGUILinkAction\(action,[\s\S]*?launchWorkspaceFiles: \(\{ path, validateExists \}\) =>[\s\S]*?openFileInSidebar\(path, validateExists\)/
  );
  assert.match(
    standaloneWindowSource,
    /validateExists &&[\s\S]*?workspaceFileManagerService\.entryExists\([\s\S]*?showWorkspaceFileMissingToast\(\)/
  );
  assert.match(
    standaloneWindowSource,
    /workspaceAppSurfaceHost\.registerPresenter\([\s\S]*?createStandaloneAgentWorkspaceAppSurfacePresenter/
  );
  assert.match(
    standaloneWindowSource,
    /<StandaloneAgentToolSidebar[\s\S]*?appOpenId=\{openAppId\}[\s\S]*?fileOpenRequest=\{fileOpenRequest\}/
  );
  assert.match(
    standaloneWindowSource,
    /<WorkspaceAppExternalBridge[\s\S]*?api=\{workspaceAppExternalApi\}[\s\S]*?openFile=\{openWorkspaceAppExternalFile\}[\s\S]*?workspaceId=\{workspaceId\}/
  );
});

test("standalone Agent handles task and app Agent launch requests", () => {
  assert.match(
    standaloneLaunchRoutingSource,
    /registerWorkspaceAgentGuiLaunchHandler\(workspaceId, \(request\) =>[\s\S]*?handleStandaloneAgentGuiLaunch\(request, \{/
  );
  assert.match(
    standaloneLaunchRoutingSource,
    /const issueManagerPresenter = useMemo\([\s\S]*?createStandaloneAgentWorkspaceIssueManagerPresenter\(\{[\s\S]*?open: setIssueManagerOpenRequest/
  );
  assert.match(
    standaloneLaunchRoutingSource,
    /registerWorkspaceIssueManagerLaunchPresenter\([\s\S]*?workspaceId,[\s\S]*?issueManagerPresenter/
  );
  assert.match(
    standaloneWindowSource,
    /useStandaloneAgentLaunchRouting\(\{[\s\S]*?agentDirectorySnapshot,[\s\S]*?headerProvider,[\s\S]*?openFileInSidebar/
  );
  assert.match(
    standaloneWindowSource,
    /<StandaloneAgentToolSidebar[\s\S]*?issueManagerOpenRequest=\{issueManagerOpenRequest\}/
  );
  assert.match(
    standaloneWindowSource,
    /prefillPromptBootstrapRequest =\s*useMemo<[\s\S]*?draftPrompt: launchDraftPrompt[\s\S]*?sequence: 1/
  );
  assert.match(
    standaloneWindowSource,
    /<DesktopAgentGUISurface[\s\S]*?prefillPromptBootstrapRequest=\{prefillPromptBootstrapRequest\}/
  );
  assert.match(
    workbenchBodySource,
    /useState<DesktopAgentGUIPrefillPromptRequest \| null>\(\s*\(\) => prefillPromptBootstrapRequest\s*\)/
  );
});

test("standalone Agent recalculates the right sidebar layout when the conversation rail collapses", () => {
  assert.match(
    standaloneWindowSource,
    /mainContentMinWidthPx=\{\s*isConversationRailCollapsed\s*\? AGENT_GUI_DETAIL_MIN_WIDTH_PX\s*:\s*headerConversationRailWidthPx\s*\+\s*agentGuiWorkbenchProviderRailWidthPx\s*\}/
  );
});

test("standalone Agent auto-hides the conversation rail below the standalone width threshold", () => {
  assert.match(
    standaloneWindowSource,
    /const isConversationRailAutoCollapsed =\s*shouldAutoCollapseAgentGUIConversationRail\(\s*frame\.width,\s*AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX\s*\)/
  );
  assert.match(
    standaloneWindowSource,
    /const isConversationRailCollapsed =\s*nodeState\.conversationRailCollapsed === true \|\|\s*isConversationRailAutoCollapsed/
  );
  assert.match(
    standaloneWindowSource,
    /isConversationRailAutoCollapsed=\{isConversationRailAutoCollapsed\}/
  );
  assert.match(
    standaloneWindowSource,
    /isConversationRailCollapsed=\{isConversationRailCollapsed\}/
  );
  assert.match(
    standaloneWindowSource,
    /conversationRailAutoCollapseWidthPx=\{\s*AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX\s*\}/
  );
});

test("standalone Agent widens a narrow window before expanding the conversation rail", () => {
  assert.match(
    standaloneWindowSource,
    /AGENT_GUI_EXPANDED_TARGET_WIDTH_PX[\s\S]*?frame\.width < 640[\s\S]*?resizeContentWidth\(\{\s*width: AGENT_GUI_EXPANDED_TARGET_WIDTH_PX\s*\}\)/
  );
});

test("standalone Agent hides home identity and shows it after local session start", () => {
  assert.match(
    standaloneWindowSource,
    /useStandaloneAgentWindowHeaderIdentity\(\{[\s\S]*?activeAgentTargetId,[\s\S]*?nodeState,[\s\S]*?sessions: activitySnapshot\.sessions/
  );
  assert.match(
    standaloneWindowHeaderSource,
    /resolveStandaloneAgentHeaderIdentity\(\{[\s\S]*?agentTargetId: input\.activeAgentTargetId,[\s\S]*?lastActiveAgentSessionId: input\.nodeState\.lastActiveAgentSessionId,[\s\S]*?sessions: input\.sessions/
  );
  assert.match(
    standaloneHeaderIdentitySource,
    /if \(!input\.lastActiveAgentSessionId\?\.trim\(\)\) \{[\s\S]*?agentTitle: null,[\s\S]*?conversationIconUrl: null,[\s\S]*?conversationTitle: null/
  );
  assert.match(
    standaloneHeaderIdentitySource,
    /agentTitle: resolveAgentGuiWorkbenchHeaderTitle\(\{[\s\S]*?agentName: agent\?\.name,[\s\S]*?conversationTitle,[\s\S]*?provider/
  );
  assert.match(
    standaloneWindowHeaderSource,
    /agentTitle=\{identity\.agentTitle\}/
  );
  assert.match(
    standaloneWindowHeaderSource,
    /conversationTitle=\{identity\.conversationTitle\}/
  );
});

test("standalone Agent hides the generic app title", () => {
  assert.match(standaloneWindowSource, /showAppTitle=\{false\}/);
  assert.doesNotMatch(
    standaloneWindowSource,
    /title=\{i18n\.t\("workspace\.agentGui\.fallbackAgentLabel"\)\}/
  );
});

test("standalone Agent hides panel toggles until its content mounts", () => {
  assert.match(
    standaloneWindowSource,
    /const \[isContentLoading, setIsContentLoading\] = useState\(true\)/
  );
  assert.match(
    standaloneWindowSource,
    /secondaryAccessory=\{isContentLoading \? null : toolActions\}/
  );
  assert.match(
    standaloneWindowSource,
    /showConversationRailToggle=\{!isContentLoading\}/
  );
  assert.match(
    standaloneWindowSource,
    /<StandaloneAgentWindowContentReady onReady=\{handleContentReady\}>[\s\S]*?<DesktopAgentGUISurface/
  );
});

test("standalone Agent loads its body with the route instead of adding a second lazy boundary", () => {
  assert.match(
    standaloneWindowSource,
    /import \{ DesktopAgentGUISurface \} from "@renderer\/features\/workspace-agent\/ui\/DesktopAgentGUIWorkbenchBody\.tsx"/
  );
  assert.doesNotMatch(
    standaloneWindowSource,
    /LazyDesktopAgentGUIWorkbenchBody/
  );
  assert.doesNotMatch(
    standaloneWindowSource,
    /import\("@renderer\/features\/workspace-agent\/ui\/DesktopAgentGUIWorkbenchBody\.tsx"\)/
  );
});

test("standalone Agent duplicates the active window without minimizing its source", () => {
  assert.match(
    standaloneWindowSource,
    /openDetachedWindow: i18n\.t\(\s*"workspace\.agentGui\.openNewWindow"\s*\)/
  );
  assert.match(
    standaloneWindowSource,
    /onOpenDetachedWindow=\{handleDuplicateStandaloneWindow\}/
  );
  assert.match(
    standaloneWindowSource,
    /handleDuplicateStandaloneWindow[\s\S]*?openAgentWindow\(\{[\s\S]*?agentDirectorySnapshot[\s\S]*?agentSessionId: nodeState\.lastActiveAgentSessionId[\s\S]*?agentTargetId: activeAgentTargetId[\s\S]*?minimizeSourceWindow: false[\s\S]*?offsetFromSourceWindow: true[\s\S]*?provider: headerProvider[\s\S]*?workspaceId/
  );
});

test("standalone Agent opens Agent settings on the General section", () => {
  assert.match(
    standaloneWindowPanelHostsSource,
    /workspaceSettingsService\.openPanel\([\s\S]*?settingsPanelRequest\.section === "agent"[\s\S]*?\? "general"/
  );
});
