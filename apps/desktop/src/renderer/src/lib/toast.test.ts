import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toastSource = readFileSync(
  new URL("./toast.tsx", import.meta.url),
  "utf8"
);
const workspaceChromeSource = readFileSync(
  new URL(
    "../features/workspace-workbench/ui/WorkspaceChrome.tsx",
    import.meta.url
  ),
  "utf8"
);
const desktopToastStyleSource = readFileSync(
  new URL(
    "../../../../../../packages/agent/gui/app/renderer/agentactivity.css",
    import.meta.url
  ),
  "utf8"
);
const uiSystemToastSource = readFileSync(
  new URL(
    "../../../../../../packages/ui/system/src/components/toast/toast.tsx",
    import.meta.url
  ),
  "utf8"
);

test("desktop decision toasts keep the collapsed stack without leaking covered content", () => {
  assert.doesNotMatch(toastSource, /<Toaster\s+expand\b/);
  assert.match(workspaceChromeSource, /"workspace-agent-decision-toast"/);
  assert.match(
    desktopToastStyleSource,
    /transform:\s*var\(--y\) translateX\(0\) !important;/
  );
  assert.match(
    desktopToastStyleSource,
    /--agent-gui-star-border-length:\s*clamp\(180px,\s*58%,\s*280px\);/
  );
  assert.match(
    desktopToastStyleSource,
    /--agent-gui-star-border-radius:\s*12px;/
  );
  assert.match(
    desktopToastStyleSource,
    /--agent-gui-star-border-color:\s*color-mix\(\s*in srgb,\s*var\(--tutti-purple\) 62%,\s*transparent\s*\);/s
  );
  assert.match(
    desktopToastStyleSource,
    /--agent-gui-star-border-mid-color:\s*color-mix\(\s*in srgb,\s*var\(--tutti-purple\) 28%,\s*transparent\s*\);/s
  );
  assert.match(
    desktopToastStyleSource,
    /--agent-gui-star-border-shadow:\s*drop-shadow\(\s*0 0 3px color-mix\(in srgb, var\(--tutti-purple\) 30%, transparent\)\s*\);/s
  );
  assert.match(
    desktopToastStyleSource,
    /\.workspace-agent-decision-toast\[data-sonner-toast\]\s*{[^}]*overflow:\s*visible;[^}]*border:\s*0;[^}]*border-radius:\s*12px;[^}]*background:\s*transparent;[^}]*padding:\s*0;/s
  );
  assert.doesNotMatch(
    desktopToastStyleSource,
    /--decision-toast-collapse-delay/
  );
  assert.match(
    desktopToastStyleSource,
    /--decision-toast-collapse-duration:\s*320ms;/
  );
  assert.match(
    desktopToastStyleSource,
    /--decision-toast-content-fade-duration:\s*160ms;/
  );
  assert.match(
    desktopToastStyleSource,
    /--decision-toast-collapsed-scale:\s*0\.94;/
  );
  assert.match(
    desktopToastStyleSource,
    /--decision-toast-collapsed-scale:\s*0\.88;/
  );
  assert.match(
    desktopToastStyleSource,
    /--decision-toast-collapsed-scale:\s*0\.82;/
  );
  assert.match(
    desktopToastStyleSource,
    /--decision-toast-collapsed-offset:\s*0px;/
  );
  assert.match(
    desktopToastStyleSource,
    /\[data-index="2"\]\s*{[^}]*--decision-toast-collapsed-offset:\s*8px;/s
  );
  assert.match(
    desktopToastStyleSource,
    /\[data-index="3"\]\s*{[^}]*--decision-toast-collapsed-offset:\s*16px;/s
  );
  assert.match(
    desktopToastStyleSource,
    /calc\(var\(--front-toast-height\) \+ var\(--decision-toast-collapsed-offset\)\)/
  );
  assert.match(desktopToastStyleSource, /min-height:\s*0 !important;/);
  assert.match(desktopToastStyleSource, /height:\s*10px !important;/);
  assert.match(desktopToastStyleSource, /max-height:\s*10px !important;/);
  assert.match(desktopToastStyleSource, /padding:\s*0 !important;/);
  assert.match(desktopToastStyleSource, /overflow:\s*hidden !important;/);
  assert.match(desktopToastStyleSource, /pointer-events:\s*auto;/);
  assert.match(desktopToastStyleSource, /border-top-width:\s*0;/);
  assert.match(
    desktopToastStyleSource,
    /\.workspace-agent-decision-toast\[data-sonner-toast\]\[data-expanded="false"\]\[data-front="false"\]\s*>\s*\[data-content\],/
  );
  assert.match(
    desktopToastStyleSource,
    /\.workspace-agent-decision-toast\[data-sonner-toast\]\[data-expanded="false"\]\[data-front="false"\]\s*>\s*\[data-content\]\s*article\s*{[^}]*margin:\s*0 !important;[^}]*background:\s*transparent !important;/s
  );
  assert.match(
    desktopToastStyleSource,
    /width:\s*calc\(var\(--width\) \* var\(--decision-toast-collapsed-scale\)\);/
  );
  assert.match(
    desktopToastStyleSource,
    /right:\s*calc\(\s*\(var\(--width\) - \(var\(--width\) \* var\(--decision-toast-collapsed-scale\)\)\) \/ 2\s*\) !important;/
  );
  assert.match(
    desktopToastStyleSource,
    /height\s+var\(--decision-toast-collapse-duration\)\s+var\(--decision-toast-collapse-easing\),/
  );
  assert.match(
    desktopToastStyleSource,
    /width\s+var\(--decision-toast-collapse-duration\)\s+var\(--decision-toast-collapse-easing\),/
  );
  assert.match(
    desktopToastStyleSource,
    /transform\s+var\(--decision-toast-collapse-duration\)\s+var\(--decision-toast-collapse-easing\),/
  );
  assert.doesNotMatch(
    desktopToastStyleSource,
    /\.workspace-agent-decision-toast\[data-sonner-toast\]\[data-expanded="false"\]\[data-front="false"\]::after/
  );
  assert.doesNotMatch(
    desktopToastStyleSource,
    /\.workspace-agent-decision-toast\[data-sonner-toast\]\[data-expanded="false"\]\[data-front="false"\]\s*>\s*\*/
  );
  assert.match(
    desktopToastStyleSource,
    /\.workspace-agent-decision-toast__edge-glow,\s+\.workspace-agent-decision-toast__close,\s+\.workspace-agent-decision-toast__content\s*{[^}]*transition:\s*opacity var\(--decision-toast-content-fade-duration\) ease;/s
  );
  assert.match(
    desktopToastStyleSource,
    /\.workspace-agent-decision-toast\[data-sonner-toast\]\[data-expanded="false"\]\[data-front="false"\]\s+\.workspace-agent-decision-toast__edge-glow,\s+\.workspace-agent-decision-toast\[data-sonner-toast\]\[data-expanded="false"\]\[data-front="false"\]\s+\.workspace-agent-decision-toast__close,\s+\.workspace-agent-decision-toast\[data-sonner-toast\]\[data-expanded="false"\]\[data-front="false"\]\s+\.workspace-agent-decision-toast__content\s*{[^}]*opacity:\s*0 !important;/s
  );
  assert.match(
    desktopToastStyleSource,
    /\.workspace-agent-decision-toast\[data-sonner-toast\]\[data-expanded="true"\]\[data-front="false"\]\s+\.workspace-agent-decision-toast__close,/
  );
  assert.match(
    desktopToastStyleSource,
    /\.workspace-agent-decision-toast\[data-sonner-toast\]\[data-expanded="true"\]\[data-front="false"\]\s+\.workspace-agent-decision-toast__content\s*{[^}]*animation:\s*workspace-agent-decision-toast-content-fade-in 180ms ease 300ms\s+forwards;/s
  );
  assert.match(
    desktopToastStyleSource,
    /@keyframes workspace-agent-decision-toast-content-fade-in/
  );
});

test("desktop decision toast mirrors the message-center prompt card chrome", () => {
  assert.match(
    workspaceChromeSource,
    /className="relative w-full min-w-0 overflow-visible rounded-\[12px\] border border-\[var\(--tutti-purple-border\)\] bg-\[var\(--tutti-purple-bg\)\] p-3\.5"/
  );
  assert.doesNotMatch(workspaceChromeSource, /relative -m-3/);
  assert.match(
    workspaceChromeSource,
    /workspace-agent-decision-toast__edge-glow agent-gui-edge-glow pointer-events-none inset-0 rounded-\[12px\]/
  );
  assert.match(
    workspaceChromeSource,
    /const displayTitle = conversationTitle \|\| agentName;/
  );
  assert.match(
    workspaceChromeSource,
    /<h3 className="min-w-0 truncate text-\[13px\] font-bold leading-5 text-\[var\(--text-secondary\)\]">[\s\S]*\{displayTitle\}[\s\S]*<\/h3>/
  );
  assert.match(
    workspaceChromeSource,
    /className="flex min-w-0 items-center justify-between gap-2\.5 pr-2"/
  );
  assert.match(
    workspaceChromeSource,
    /waitingStatusLabel=\{t\(\s*"workspace\.agentMessageCenter\.waitingNotificationStatus"\s*\)\}/
  );
  assert.match(
    workspaceChromeSource,
    /<StatusDot[\s\S]*tone="amber"[\s\S]*pulse[\s\S]*size="sm"[\s\S]*title=\{waitingStatusLabel\}/
  );
  assert.match(
    workspaceChromeSource,
    /className="workspace-agent-decision-toast__prompt min-w-0"/
  );
  assert.match(
    desktopToastStyleSource,
    /\.workspace-agent-decision-toast__prompt\s+\.agent-gui-conversation__interactive-prompt-card\s*{[^}]*border:\s*0;[^}]*padding:\s*12px;[^}]*box-shadow:\s*none;/s
  );
  assert.match(
    workspaceChromeSource,
    /className="flex min-w-0 items-center gap-2 text-\[13px\] font-normal leading-5 text-\[var\(--text-secondary\)\]"/
  );
  assert.match(
    workspaceChromeSource,
    /<span className="min-w-0 truncate">\{agentName\}<\/span>/
  );
  assert.doesNotMatch(
    workspaceChromeSource,
    /WorkspaceAgentDecisionToastDescription|splitMiddleTruncatedToastText|workspace-agent-decision-toast__description/
  );
});

test("desktop generic toasts do not use edge glow", () => {
  assert.doesNotMatch(toastSource, /agent-gui-edge-glow/);
});

test("desktop success toasts use the shared ui-system toast primitive", () => {
  assert.match(toastSource, /ToastRoot/);
  assert.match(toastSource, /ToastTitle/);
  assert.match(toastSource, /ToastDescription/);
  assert.match(uiSystemToastSource, /box-border w-full px-2/);
  assert.match(uiSystemToastSource, /\[overflow-wrap:anywhere\]/);
  assert.match(
    toastSource,
    /type DesktopToastTone = "default" \| "destructive" \| "success";/
  );
  assert.match(
    toastSource,
    /Success\(title: string, description\?: string\): void \{\s*pushToast\(\{\s*description,\s*title,\s*tone: "success"\s*\}\);/s
  );
  assert.doesNotMatch(toastSource, /toast as uiSystemToast/);
  assert.doesNotMatch(toastSource, /uiSystemToast\.success\(/);
});

test("desktop decision toasts stay visible until the user acts", () => {
  assert.match(
    workspaceChromeSource,
    /const WORKSPACE_AGENT_DECISION_TOAST_DURATION = Infinity;/
  );
  assert.match(
    workspaceChromeSource,
    /duration: WORKSPACE_AGENT_DECISION_TOAST_DURATION/
  );
  assert.doesNotMatch(
    workspaceChromeSource,
    /WORKSPACE_AGENT_DECISION_TOAST_DURATION_MS = \d+/
  );
});

test("desktop decision toasts reuse the shared interactive prompt surface", () => {
  assert.match(workspaceChromeSource, /AgentInteractivePromptSurface/);
  assert.match(
    workspaceChromeSource,
    /buildWorkspaceAgentInteractivePromptLabels/
  );
  assert.match(
    workspaceChromeSource,
    /buildWorkspaceAgentInteractivePromptLabels\([\s\S]*item\.provider[\s\S]*\)/
  );
  assert.match(
    workspaceChromeSource,
    /<AgentInteractivePromptSurface\s+embedded\s+keyboardShortcuts=\{false\}/
  );
  assert.doesNotMatch(
    workspaceChromeSource,
    /options\.map\(\(option\) =>\s*\(\s*<button/s
  );
});

test("desktop decision toast prompt uses the agent gui ui font", () => {
  assert.match(
    desktopToastStyleSource,
    /\.agent-gui-conversation__interactive-prompt\s*{[^}]*font-family:\s*var\(\s*--tsh-font-ui,\s*var\(--font-ui,\s*var\(--font-sans-system,\s*sans-serif\)\)\s*\);/s
  );
  assert.match(
    desktopToastStyleSource,
    /\.agent-gui-conversation__interactive-option-button\s*{[^}]*font-family:\s*inherit;/s
  );
  assert.match(
    desktopToastStyleSource,
    /\.agent-gui-conversation__interactive-prompt-actions button\s*{[^}]*font-family:\s*inherit;/s
  );
  assert.match(
    desktopToastStyleSource,
    /\.agent-gui-conversation__interactive-option-command-description\s*{[^}]*font-family:\s*var\(\s*--tsh-font-mono,/s
  );
});
