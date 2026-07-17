import assert from "node:assert/strict";
import test from "node:test";
import { en } from "../../../../../shared/i18n/locales/en.ts";
import { zhCN } from "../../../../../shared/i18n/locales/zh-CN.ts";

const agentsCopyByLocale = {
  en: en.workspace.settings.apps.agents,
  "zh-CN": zhCN.workspace.settings.apps.agents
} as const;

test("agent editor copy says Agent Runtime and never Harness", () => {
  for (const [locale, copy] of Object.entries(agentsCopyByLocale)) {
    assert.equal(copy.harnessLabel, "Agent Runtime", locale);
    for (const [key, value] of Object.entries(copy)) {
      assert.ok(
        typeof value !== "string" || !value.includes("Harness"),
        `${locale} agents.${key} still mentions Harness: ${String(value)}`
      );
    }
  }
});

test("purpose copy is a neutral description field", () => {
  assert.equal(agentsCopyByLocale.en.purposeLabel, "Description");
  assert.equal(agentsCopyByLocale["zh-CN"].purposeLabel, "描述");
});

test("removed editor sections have no orphaned agent copy keys", () => {
  const removedKeys = [
    // 2-1 smart generation
    "generate",
    "generateChoosePlan",
    "generateFailed",
    "generateModelDisclosure",
    "generateSafetyHint",
    "generateTitle",
    "generatedCallConditionsTitle",
    "generatedRuleDisabled",
    "generatedRulesDescription",
    "generatedRulesSaveFailed",
    "generatedRulesTitle",
    "generating",
    "generationRequirementsPlaceholder",
    "generationRequiresPlan",
    // 2-5 model failover chain
    "addModelFallback",
    "modelFallbackDescription",
    "modelFallbackLabel",
    "noModelFallbackRecommendation",
    "recommendModelFallback",
    "recommendModelFallbackFailed",
    "recommendingModelFallback",
    "removeModelFallback",
    // 2-7 compatible capabilities
    "capabilitiesTitle",
    "capabilitiesAutomaticDescription",
    "capabilitiesExplicitDescription",
    "capabilitiesLoading",
    "capabilitiesLoadFailed",
    "capabilityDetails",
    "capabilityGroups",
    "capabilityStatuses",
    "noCompatibleCapabilities",
    "restoreAutomaticCapabilities",
    // 2-8 available-for-new-conversations switch
    "enabledLabel",
    // 2-9 advanced capability IDs and permissions
    "advancedCapabilityIdsDescription",
    "advancedCapabilityIdsTitle",
    "permissionsLabel",
    "permissionsPlaceholder",
    "skillsLabel",
    "skillsPlaceholder",
    "toolsLabel",
    "toolsPlaceholder"
  ];
  for (const [locale, copy] of Object.entries(agentsCopyByLocale)) {
    for (const key of removedKeys) {
      assert.ok(!(key in copy), `${locale} agents.${key} should be removed`);
    }
  }
});
