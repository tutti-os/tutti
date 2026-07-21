import { providerSwitchScenario } from "./agent-gui-performance-scenario.mjs";
import {
  providerSessionCycleScenario,
  sessionSwitchScenario
} from "./agent-gui-session-performance-scenarios.mjs";
import {
  desktopWindowStateScenario,
  workbenchWindowLifecycleScenario
} from "./agent-gui-window-performance-scenarios.mjs";
import {
  composerOverflowResizeScenario,
  railScopeRevealScenario,
  virtualizedStreamingScenario
} from "./agent-gui-layout-performance-scenarios.mjs";

export const agentGuiPerformanceScenarios = [
  providerSwitchScenario,
  sessionSwitchScenario,
  providerSessionCycleScenario,
  virtualizedStreamingScenario,
  railScopeRevealScenario,
  composerOverflowResizeScenario,
  workbenchWindowLifecycleScenario,
  desktopWindowStateScenario
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
