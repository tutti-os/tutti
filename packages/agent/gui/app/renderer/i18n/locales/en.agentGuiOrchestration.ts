import { enTuttiModePlan } from "./en.tuttiModePlan.ts";

export const enAgentGuiOrchestration = {
  codexSaverModeLabel: "Codex saver mode",
  codexSaverModeDescription:
    "Keep the selected main model. Suitable self-contained subtasks use Luna Max at roughly one-tenth the current quota cost of Sol High. Quality and speed vary by task.",
  rtkSaverModeLabel: "RTK saver mode",
  rtkSaverModeDescription:
    "Keep the selected model and add a session-private rtk command plus RTK.md instructions to reduce tool-output token usage.",
  planModeLabel: "Plan Mode",
  normalModeLabel: "Normal",
  normalModeDescription: "Execute the request directly",
  tuttiModeLabel: "Tutti Mode",
  tuttiModeDescription:
    "Type what you want done — Tutti plans it, splits the tasks, and assigns each to the right agent and model",
  tuttiModeRemove: "Turn off Tutti mode",
  tuttiBudgetTitle: "Tutti preferences",
  tuttiBudgetEffectLabel: "Effect",
  tuttiBudgetSpeedLabel: "Speed",
  tuttiBudgetPreviewHint: "Actual parallelism depends on task dependencies.",
  tuttiBudgetPreviewCost: "Economical",
  tuttiBudgetPreviewBalance: "Balanced",
  tuttiBudgetPreviewPowerful: "Powerful",
  tuttiBudgetModelPreferenceLabel: "Model strategy",
  tuttiBudgetModelPreferenceCost: "Economical",
  tuttiBudgetModelPreferenceBalance: "Balanced",
  tuttiBudgetModelPreferencePowerful: "Most capable",
  tuttiBudgetParallelismLabel: "Parallel target",
  tuttiBudgetParallelismValue: "Up to {{count}} agents",
  tuttiBudgetParallelismValue_one: "{{count}} agent",
  tuttiBudgetParallelismValue_other: "Up to {{count}} agents",
  tuttiModeUpdateFailed: "Tutti mode couldn't be updated. Try again.",
  tuttiModeUpdateUncertain:
    "Tutti mode is still being reconciled. Try again after it finishes.",
  tuttiModePlan: enTuttiModePlan,
  planModeDescription: "Plan first, then implement or break down into an Issue",
  planModeOnLabel: "On",
  planModeOffLabel: "Off",
  planUnavailable: "Plan unavailable"
} as const;
