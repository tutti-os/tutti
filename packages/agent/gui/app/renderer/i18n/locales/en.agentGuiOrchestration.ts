import { enTuttiModePlan } from "./en.tuttiModePlan.ts";

export const enAgentGuiOrchestration = {
  planModeLabel: "Plan Mode",
  normalModeLabel: "Normal",
  normalModeDescription: "Execute the request directly",
  tuttiModeLabel: "Tutti",
  tuttiModeDescription:
    "Ask the agent to prefer Tutti's native workflow capabilities",
  tuttiModeRemove: "Turn off Tutti mode",
  tuttiBudgetTitle: "Tutti intensity",
  tuttiBudgetIntensityLabel: "Intensity",
  tuttiBudgetIntensityMin: "Minimal",
  tuttiBudgetIntensityMax: "Maximal",
  tuttiBudgetPreviewTitle: "Planner tendency",
  tuttiBudgetPreviewHint:
    "The exact model and task graph are inferred from the request and selected Skills.",
  tuttiBudgetPreviewCost: "Cost",
  tuttiBudgetPreviewBalance: "Balance",
  tuttiBudgetPreviewPowerful: "Powerful",
  tuttiBudgetModelStrengthLabel: "Model strength",
  tuttiBudgetModelStrengthCost: "Economical",
  tuttiBudgetModelStrengthBalance: "Balanced",
  tuttiBudgetModelStrengthPowerful: "Most capable",
  tuttiBudgetAgentCountLabel: "Agent count",
  tuttiBudgetAgentCountCost: "1",
  tuttiBudgetAgentCountBalance: "2–3",
  tuttiBudgetAgentCountPowerful: "Up to 4 parallel",
  tuttiBudgetConfirm: "Confirm",
  tuttiBudgetCancel: "Cancel",
  tuttiModeUpdateFailed: "Tutti mode couldn't be updated. Try again.",
  tuttiModeUpdateUncertain:
    "Tutti mode is still being reconciled. Try again after it finishes.",
  tuttiModePlan: enTuttiModePlan,
  planModeDescription: "Plan first, then implement or break down into an Issue",
  planModeOnLabel: "On",
  planModeOffLabel: "Off",
  planUnavailable: "Plan unavailable"
} as const;
