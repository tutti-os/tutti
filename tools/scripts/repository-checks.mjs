const scriptInfrastructureFiles = new Set([
  "tools/scripts/change-classification.mjs",
  "tools/scripts/change-classification.test.mjs",
  "tools/scripts/repository-checks.mjs",
  "tools/scripts/run-repository-checks.mjs"
]);

const javascriptExtensions = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const uiBoundaryExtensions =
  /\.(?:cjs|css|cts|js|json|jsx|mjs|mts|svg|ts|tsx)$/u;

export const repositoryCheckDefinitions = [
  {
    group: "policy",
    key: "policy:tutti-names",
    label: "repository naming policy",
    script: "check:tutti-names",
    matches: () => true
  },
  {
    group: "policy",
    key: "policy:backdrop-filter-authoring",
    label: "backdrop-filter authoring policy",
    script: "check:backdrop-filter-authoring",
    matches: isBackdropFilterAuthoringRelevant
  },
  {
    group: "policy",
    key: "policy:css-has-performance",
    label: "CSS :has() performance policy",
    script: "check:css-has-performance",
    matches: isCssHasPerformanceRelevant
  },
  {
    group: "policy",
    key: "policy:runtime-image-budgets",
    label: "runtime image budgets",
    script: "check:runtime-image-budgets",
    matches: isRuntimeImageBudgetRelevant
  },
  {
    group: "contracts",
    key: "contracts:tool-tests",
    label: "repository tool contracts",
    script: "test:tools",
    matches: isToolContractRelevant
  },
  {
    group: "contracts",
    key: "contracts:device-link-android",
    label: "DeviceLink Android contract",
    script: "check:device-link-android",
    matches: (file) => file.startsWith("packages/device-link/")
  },
  {
    group: "generated",
    key: "generated:defaults",
    label: "generated defaults",
    script: "check:defaults-generated",
    matches: isDefaultsContractRelevant
  },
  {
    group: "generated",
    key: "generated:api",
    label: "generated API",
    script: "check:api-generated",
    matches: isApiContractRelevant
  },
  {
    group: "generated",
    key: "generated:event-protocol",
    label: "generated event protocol",
    script: "check:event-protocol-generated",
    matches: isEventProtocolContractRelevant
  },
  {
    group: "generated",
    key: "generated:workbench-go-contract",
    label: "generated workbench Go contract",
    script: "check:workbench-go-contract",
    matches: isWorkbenchGoContractRelevant
  },
  {
    group: "generated",
    key: "generated:agent-provider-catalog",
    label: "generated agent provider catalog",
    script: "check:agent-gui-provider-catalog-generated",
    matches: isAgentProviderCatalogRelevant
  },
  {
    group: "generated",
    key: "generated:codexproto",
    label: "generated Codex protocol",
    script: "check:codexproto-generated",
    matches: isCodexProtocolRelevant
  },
  {
    group: "boundaries",
    key: "boundary:electron",
    label: "Electron runtime boundary",
    script: "check:electron-runtime-boundaries",
    matches: isElectronRuntimeBoundaryRelevant
  },
  {
    group: "boundaries",
    key: "boundary:ui",
    label: "UI boundary",
    script: "check:ui-boundaries",
    matches: isUiBoundaryRelevant
  },
  {
    group: "boundaries",
    key: "boundary:renderer",
    label: "renderer feature boundary",
    script: "check:renderer-boundaries",
    matches: isRendererBoundaryRelevant
  },
  {
    group: "boundaries",
    key: "boundary:agent-activity-runtime",
    label: "Agent activity runtime boundary",
    script: "check:agent-activity-runtime-boundaries",
    matches: isAgentActivityRuntimeBoundaryRelevant
  },
  {
    group: "boundaries",
    key: "boundary:agent-host",
    label: "Agent Host boundary",
    script: "check:agent-host-boundary",
    matches: isAgentHostBoundaryRelevant
  },
  {
    group: "boundaries",
    key: "boundary:agent-provider-strategy",
    label: "agent provider strategy boundary",
    script: "check:agent-provider-strategy-boundaries",
    matches: isAgentProviderStrategyRelevant
  },
  {
    group: "boundaries",
    key: "boundary:agent-gui-degradation",
    label: "Agent GUI degradation boundary",
    script: "check:agent-gui-degradation",
    matches: isAgentGuiDegradationRelevant
  },
  {
    group: "boundaries",
    key: "boundary:i18n",
    label: "i18n boundary",
    script: "check:i18n",
    matches: isI18nRelevant
  }
];

export function selectRepositoryChecks(changedFiles, { group } = {}) {
  if (changedFiles.length === 0) {
    return [];
  }

  return repositoryCheckDefinitions.filter(
    (definition) =>
      (!group || definition.group === group) &&
      selectRepositoryCheckInputs(definition, changedFiles).length > 0
  );
}

export function selectRepositoryCheckInputs(definition, changedFiles) {
  return changedFiles.filter(
    (file) => isCheckInfrastructure(file) || definition.matches(normalize(file))
  );
}

export function selectedRepositoryCheckGroups(changedFiles) {
  return new Set(
    selectRepositoryChecks(changedFiles).map((definition) => definition.group)
  );
}

export function isToolContractRelevant(file) {
  const normalized = normalize(file);
  return (
    normalized.startsWith("tools/scripts/") ||
    normalized.startsWith("packages/workspace/app-release-tools/") ||
    normalized.startsWith("apps/desktop/scripts/") ||
    normalized.startsWith(".github/workflows/") ||
    normalized.startsWith(".husky/") ||
    normalized === "package.json" ||
    normalized === "apps/desktop/package.json" ||
    normalized === "apps/desktop/electron.vite.config.ts" ||
    normalized === "apps/desktop/build/icon.png" ||
    normalized === "apps/desktop/src/preload/entries/browserNodeGuest.ts" ||
    normalized ===
      "packages/browser/workbench-node/src/electron-main/loopbackPreviewProxy.ts" ||
    normalized === "docs/conventions/desktop-release.md" ||
    normalized ===
      "services/tuttid/service/workspace/agent_workspace_app_reference/references/github-actions-release.md"
  );
}

function isBackdropFilterAuthoringRelevant(file) {
  return (
    /^(?:apps|packages|services)\//u.test(file) &&
    /\.(?:cjs|css|cts|html|js|jsx|mjs|mts|ts|tsx)$/u.test(file)
  );
}

function isCssHasPerformanceRelevant(file) {
  return (
    (/^(?:apps|packages|services)\//u.test(file) && file.endsWith(".css")) ||
    file === "tools/scripts/check-css-has-performance.mjs" ||
    file === "tools/scripts/css-has-performance-policy.mjs" ||
    file === "tools/scripts/css-has-performance-policy.test.mjs"
  );
}

function isRuntimeImageBudgetRelevant(file) {
  return (
    file.startsWith(
      "apps/desktop/src/renderer/src/assets/workspace-canvas/dock/"
    ) ||
    file.startsWith(
      "apps/desktop/src/renderer/src/features/app-update/assets/"
    ) ||
    file ===
      "apps/desktop/src/renderer/src/assets/account-plans/reward-toast-bg.png" ||
    file.startsWith("packages/agent/gui/app/renderer/assets/icons/") ||
    file ===
      "packages/browser/workbench-node/src/assets/workspace-dock-website.png" ||
    file ===
      "packages/workspace/issue-manager/src/assets/workspace-dock-task.png" ||
    file ===
      "packages/workspace/file-manager/src/assets/workspace-archive-fallback.png" ||
    file.startsWith("packages/commerce/web/src/assets/") ||
    file.startsWith(
      "services/tuttid/builtin-apps/tutti-onboarding/public/assets/"
    ) ||
    file === "tools/scripts/check-runtime-image-budgets.mjs" ||
    file === "tools/scripts/check-runtime-image-budgets.test.mjs"
  );
}

function isDefaultsContractRelevant(file) {
  return (
    file === "config/tutti.defaults.json" ||
    file === "services/tuttid/types/defaults_generated.go" ||
    file === "apps/cli/internal/defaults/defaults_generated.go" ||
    file === "apps/desktop/src/main/generated/defaults.ts" ||
    file === "packages/configs/prettier/base.mjs" ||
    file === "tools/scripts/generate-defaults.mjs"
  );
}

function isApiContractRelevant(file) {
  return (
    file.startsWith("services/tuttid/api/openapi/") ||
    file.startsWith("services/tuttid/api/generated/") ||
    file.startsWith("packages/clients/tuttid-ts/src/generated/") ||
    file === "packages/workbench/snapshot/src/schema.json" ||
    file === "tools/scripts/generate-openapi.mjs" ||
    file === "tools/scripts/sync-workbench-openapi-schema.mjs" ||
    file === "tools/scripts/check-agent-protocol-enums.mjs"
  );
}

function isEventProtocolContractRelevant(file) {
  return (
    file.startsWith("packages/events/protocol/definitions/") ||
    file.startsWith("packages/events/protocol/schemas/") ||
    file.startsWith("packages/events/protocol/src/generated/") ||
    file === "services/tuttid/api/events/generated/protocol.gen.go" ||
    file === "packages/configs/prettier/base.mjs" ||
    file === "tools/scripts/generate-event-protocol.mjs" ||
    file === "tools/scripts/check-agent-protocol-enums.mjs"
  );
}

function isWorkbenchGoContractRelevant(file) {
  return (
    file === "packages/workbench/snapshot/src/schema.json" ||
    file === "packages/workbench/snapshot/src/limits.ts" ||
    file === "packages/workbench/service/workbench_snapshot_contract.gen.go" ||
    file === "tools/scripts/generate-workbench-go-contract.mjs"
  );
}

function isAgentProviderCatalogRelevant(file) {
  return (
    file.startsWith("packages/agent/daemon/providerregistry/") ||
    file === "services/tuttid/api/openapi/tuttid.v1.yaml" ||
    file === "packages/agent/gui/generated/providerIdentityCatalog.ts" ||
    file ===
      "packages/agent/activity-core/src/generated/agentCapabilityKeys.ts" ||
    file.startsWith("packages/agent/gui/app/renderer/assets/icons/") ||
    file.startsWith("packages/agent/gui/app/renderer/i18n/locales/") ||
    file === "packages/agent/gui/providerIconAssets.spec.ts" ||
    file === "packages/agent/gui/providerIdentityCatalog.spec.ts" ||
    file === "tools/scripts/generate-agent-gui-provider-catalog.mjs" ||
    file === "tools/scripts/check-agent-gui-provider-catalog.mjs"
  );
}

function isCodexProtocolRelevant(file) {
  return (
    file.startsWith("packages/agent/daemon/runtime/codexproto/") ||
    file === "tools/scripts/check-codexproto-generated.mjs" ||
    file === "tools/scripts/git-environment.mjs"
  );
}

function isElectronRuntimeBoundaryRelevant(file) {
  return (
    file === "apps/desktop/electron.vite.config.ts" ||
    file.startsWith("apps/desktop/src/main/") ||
    file.startsWith("apps/desktop/src/preload/") ||
    file.startsWith("apps/desktop/src/shared/") ||
    file.startsWith("packages/") ||
    file === "tools/scripts/check-electron-runtime-boundaries.mjs" ||
    file === "tools/scripts/check-electron-runtime-boundaries.test.mjs"
  );
}

function isUiBoundaryRelevant(file) {
  return (
    (file.startsWith("apps/") ||
      file.startsWith("packages/") ||
      file.startsWith("tools/")) &&
    uiBoundaryExtensions.test(file)
  );
}

export function isRendererBoundaryRelevant(file) {
  return (
    file.startsWith("apps/desktop/src/renderer/src/") ||
    file === "tools/scripts/check-renderer-feature-boundaries.mjs" ||
    file === "tools/scripts/check-renderer-feature-boundaries.test.mjs"
  );
}

export function isAgentActivityRuntimeBoundaryRelevant(file) {
  return (
    file.startsWith("packages/agent/gui/") ||
    file.startsWith("packages/agent/activity-core/") ||
    file.startsWith(
      "apps/desktop/src/renderer/src/features/workspace-agent/"
    ) ||
    file.startsWith(
      "apps/desktop/src/renderer/src/features/workspace-workbench/"
    ) ||
    file === "tools/scripts/check-agent-activity-runtime-boundaries.mjs" ||
    file === "tools/scripts/check-agent-activity-runtime-boundaries.test.mjs" ||
    file.startsWith("tools/fixtures/agent-activity-runtime-boundaries/")
  );
}

function isAgentHostBoundaryRelevant(file) {
  return (
    file.startsWith("services/tuttid/service/agent/") ||
    file === "tools/scripts/check-agent-host-boundary.mjs" ||
    file === "tools/scripts/check-agent-host-boundary.test.mjs"
  );
}

function isAgentProviderStrategyRelevant(file) {
  return (
    ((file.startsWith("services/tuttid/") ||
      file.startsWith("packages/agent/daemon/") ||
      file.startsWith("apps/desktop/src/")) &&
      /\.(?:go|ts|tsx)$/u.test(file)) ||
    file === "tools/scripts/check-agent-provider-strategy-boundaries.mjs" ||
    file === "tools/scripts/check-agent-provider-strategy-boundaries.test.mjs"
  );
}

function isAgentGuiDegradationRelevant(file) {
  return (
    file.startsWith("packages/agent/") ||
    file.startsWith("tools/degradation-baseline/") ||
    file === "tools/scripts/check-agent-gui-degradation.mjs" ||
    file === "tools/scripts/check-agent-gui-degradation.test.mjs"
  );
}

function isI18nRelevant(file) {
  return (
    ((file.startsWith("apps/desktop/src/main/") ||
      file.startsWith("apps/desktop/src/renderer/src/") ||
      file.startsWith("apps/desktop/src/shared/i18n/") ||
      file.startsWith("packages/")) &&
      javascriptExtensions.test(file)) ||
    file === "tools/scripts/check-i18n.mjs" ||
    file === "tools/scripts/check-i18n.test.mjs"
  );
}

function isCheckInfrastructure(file) {
  return scriptInfrastructureFiles.has(normalize(file));
}

function normalize(file) {
  return file.replaceAll("\\", "/");
}
