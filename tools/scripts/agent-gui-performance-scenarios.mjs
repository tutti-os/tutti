import { providerSwitchScenario } from "./agent-gui-performance-scenario.mjs";
import {
  providerSessionCycleScenario,
  sessionSwitchScenario
} from "./agent-gui-session-performance-scenarios.mjs";
import {
  desktopWindowStateScenario,
  workbenchFiftyWindowStressScenario,
  workbenchWindowDragScenario,
  workbenchWindowLifecycleScenario
} from "./agent-gui-window-performance-scenarios.mjs";
import {
  composerOverflowResizeScenario,
  railScopeRevealScenario,
  virtualizedStreamingScenario
} from "./agent-gui-layout-performance-scenarios.mjs";
import { composerInputScenario } from "./agent-gui-composer-performance-scenarios.mjs";
import { virtualizedScrollLocatorScenario } from "./agent-gui-scroll-performance-scenario.mjs";
import {
  browserBehindAgentGUIPixelsScenario,
  virtualizedOversizedActiveTurnScenario,
  virtualizedSessionCycleScenario
} from "./agent-gui-virtualization-performance-scenarios.mjs";
import { providerStatusFocusRefreshScenario } from "./agent-provider-status-performance-scenario.mjs";
import { concurrentAgentStreamingScenario } from "./agent-gui-concurrent-streaming-performance-scenario.mjs";
import { workbenchDockPopupPreviewScenario } from "./agent-gui-dock-preview-performance-scenario.mjs";

export const agentGuiPerformanceScenarios = [
  providerSwitchScenario,
  sessionSwitchScenario,
  providerSessionCycleScenario,
  virtualizedStreamingScenario,
  concurrentAgentStreamingScenario,
  virtualizedScrollLocatorScenario,
  virtualizedSessionCycleScenario,
  virtualizedOversizedActiveTurnScenario,
  browserBehindAgentGUIPixelsScenario,
  railScopeRevealScenario,
  composerInputScenario,
  composerOverflowResizeScenario,
  workbenchDockPopupPreviewScenario,
  workbenchFiftyWindowStressScenario,
  workbenchWindowDragScenario,
  workbenchWindowLifecycleScenario,
  desktopWindowStateScenario,
  providerStatusFocusRefreshScenario
];

export function resolveAgentGuiPerformanceScenario(id) {
  const scenario = agentGuiPerformanceScenarios.find(
    (candidate) => candidate.id === id
  );
  if (!scenario) {
    throw new Error(
      `unknown scenario: ${id}; available: ${agentGuiPerformanceScenarios.map((candidate) => candidate.id).join(", ")}`
    );
  }
  return scenario;
}
