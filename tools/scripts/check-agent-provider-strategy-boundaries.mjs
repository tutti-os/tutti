import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "../..");
const roots = ["services/tuttid", "packages/agent/daemon", "apps/desktop/src"];
const sourceExtensions = [".go", ".ts", ".tsx"];

// Registry declarations and generated protocol enums own provider identity.
// Provider-owned adapters and parsers may translate a provider-specific wire
// contract, but cross-provider policy files must use registry descriptors.
const exemptPrefixes = [
  "packages/agent/daemon/providerregistry/",
  "services/tuttid/api/generated/"
];
const exemptFiles = new Set([
  "packages/agent/daemon/activity/events/activity_types.go",
  "packages/agent/daemon/runtime/types.go",
  "packages/agent/daemon/runtime/codex_appserver_adapter.go",
  "packages/agent/daemon/runtime/codex_appserver_startup_trace.go",
  "packages/agent/daemon/runtime/claude_sdk_adapter.go",
  "packages/agent/daemon/runtime/claude_sdk_execution.go",
  "packages/agent/daemon/runtime/claude_sdk_lifecycle.go",
  "packages/agent/daemon/runtime/claude_sdk_live_state.go",
  "packages/agent/daemon/runtime/acp_provider_cursor.go",
  "packages/agent/daemon/runtime/acp_provider_hermes.go",
  "packages/agent/daemon/runtime/acp_provider_nexight.go",
  "packages/agent/daemon/runtime/acp_provider_openclaw.go",
  "services/tuttid/biz/agentprovider/provider.go",
  "services/tuttid/service/agent/external_import_parse.go",
  "services/tuttid/service/agentstatus/registry.go"
]);
const providerBehaviorCollectionName =
  /(?:action|dispatch|enabled|fallback|handler|hidden|install|login|policy|priority|probe|runtime|status|strategy|supported|visibility)/iu;

if (isMainModule()) {
  const providerIds = readRegistryProviderIds();
  const violations = scanWorkspace(providerIds);
  if (violations.length > 0) {
    console.error(
      "Provider behavior must dispatch through providerregistry strategies. " +
        "Provider identity is allowed only in registry declarations, generated enums, and exact provider-owned adapter/parser exemptions:\n" +
        violations.join("\n")
    );
    process.exitCode = 1;
  }
}

export function findProviderIdentityViolations(path, source, providerIds) {
  if (isTestSource(path) || isExemptPath(path)) {
    return [];
  }
  const patterns = createProviderIdentityPatterns(providerIds);
  const violations = [];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (Object.values(patterns).some((pattern) => pattern.test(line))) {
      violations.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  }
  violations.push(
    ...findProviderIdentityCollectionMembershipViolations(
      path,
      source,
      providerIds
    )
  );
  return violations;
}

function findProviderIdentityCollectionMembershipViolations(
  path,
  source,
  providerIds
) {
  const providerLiteral = new RegExp(
    `["\`](?:${providerIds.map(escapeRegExp).join("|")})["\`]`,
    "gu"
  );
  const collectionDeclaration =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+Set(?:<[^;=]*?>)?\s*\(\s*)?\[([\s\S]*?)\]\s*\)?(?:\s+as\s+const)?(?:\s+satisfies\s+[^;]+)?\s*;/gu;
  const violations = [];
  for (const declaration of source.matchAll(collectionDeclaration)) {
    const name = declaration[1];
    const items = declaration[2];
    if (!providerBehaviorCollectionName.test(name)) {
      continue;
    }
    const membership = new RegExp(
      `\\b${escapeRegExp(name)}\\s*\\.(?:has|includes)\\s*\\(`,
      "u"
    );
    if (!membership.test(source)) {
      continue;
    }
    for (const literal of items.matchAll(providerLiteral)) {
      const literalOffset =
        (declaration.index ?? 0) +
        declaration[0].indexOf(items) +
        literal.index;
      const lineNumber = source.slice(0, literalOffset).split(/\r?\n/u).length;
      violations.push(`${path}:${lineNumber}: ${literal[0]}`);
    }
  }
  return violations;
}

export function isExemptPath(path) {
  return (
    exemptFiles.has(path) ||
    exemptPrefixes.some((prefix) => path.startsWith(prefix))
  );
}

export function createProviderIdentityPatterns(providerIds) {
  const ids = validateProviderIds(providerIds);
  const idAlternation = ids.map(escapeRegExp).join("|");
  const stemAlternation = ids
    .map(providerIdToGoStem)
    .map(escapeRegExp)
    .join("|");
  const constantIdentity = new RegExp(
    `(?:\\bagentprovider(?:biz)?\\.(?:${stemAlternation})|\\bproviderregistry\\.(?:${stemAlternation})ProviderID|\\bProvider(?:${stemAlternation})|\\b(?:${stemAlternation})ProviderID)\\b`,
    "iu"
  );
  const comparedLiteral = new RegExp(
    `(?:==|!=)\\s*["\`](?:${idAlternation})["\`]|["\`](?:${idAlternation})["\`]\\s*(?:==|!=)`,
    "u"
  );
  const caseLiteral = new RegExp(
    `\\bcase\\s+[^:]*["\`](?:${idAlternation})["\`][^:]*:`,
    "u"
  );
  return { constantIdentity, comparedLiteral, caseLiteral };
}

function scanWorkspace(providerIds) {
  const violations = [];
  for (const root of roots) {
    for (const file of sourceFiles(join(workspaceRoot, root))) {
      const path = relative(workspaceRoot, file).replaceAll("\\", "/");
      violations.push(
        ...findProviderIdentityViolations(
          path,
          readFileSync(file, "utf8"),
          providerIds
        )
      );
    }
  }
  return violations;
}

function readRegistryProviderIds() {
  const daemonRoot = join(workspaceRoot, "packages/agent/daemon");
  const output = execFileSync(
    "go",
    ["run", "./providerregistry/cmd/provideridentitycatalog"],
    { cwd: daemonRoot, encoding: "utf8" }
  );
  const catalog = JSON.parse(output);
  if (!Array.isArray(catalog)) {
    throw new TypeError("provider identity catalog must be an array");
  }
  return validateProviderIds(catalog.map((entry) => entry?.providerId));
}

function validateProviderIds(providerIds) {
  if (
    !Array.isArray(providerIds) ||
    providerIds.length === 0 ||
    providerIds.some(
      (providerId) =>
        typeof providerId !== "string" ||
        providerId.trim() === "" ||
        providerId !== providerId.trim()
    ) ||
    new Set(providerIds).size !== providerIds.length
  ) {
    throw new TypeError("provider ids must be unique non-empty strings");
  }
  return providerIds;
}

function providerIdToGoStem(providerId) {
  return providerId
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isMainModule() {
  return Boolean(process.argv[1] && resolve(process.argv[1]) === scriptPath);
}

function isTestSource(path) {
  return /(?:_test\.go|\.(?:test|spec)\.tsx?)$/u.test(path);
}

function sourceFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...sourceFiles(path));
    } else if (
      entry.isFile() &&
      sourceExtensions.some((extension) => entry.name.endsWith(extension))
    ) {
      result.push(path);
    }
  }
  return result;
}
