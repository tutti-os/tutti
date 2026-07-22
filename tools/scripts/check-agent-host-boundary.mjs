import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "../..");

// Agent application lifecycle semantics (session/turn/goal/runtime-operation
// creation, sendability, terminal state, recovery) belong to
// `packages/agent/host`. `services/tuttid/service/agent` is an adapter surface:
// HTTP/query/composer/analytics/transport translation that delegates through
// `ApplicationHost()`. Introducing a new lifecycle orchestration type here
// (a `*Coordinator`, `*Worker`, or `*Actor` production type/file) rebuilds the
// application core in the adapter and is rejected. See
// `packages/agent/host/README.md` and the conformance harness under
// `packages/agent/host/conformance`.
const scanRoot = "services/tuttid/service/agent";

// Ratchet snapshot. These files predate the boundary check and are the only
// production files permitted to carry a lifecycle-orchestration name. The list
// may only shrink. Adding a new violation requires an explicit, reviewed edit
// here with an ownership reason, which is the whole point of the ratchet: new
// application-core orchestration must land in `packages/agent/host`, not here.
const ALLOWLIST = new Set([
  // Composer live-model discovery is a provider-catalog adapter concern, not
  // session/turn/goal lifecycle. It predates this check.
  "services/tuttid/service/agent/composer_live_model_coordinator.go"
]);

// A production type whose name ends in one of these words is treated as an
// application-core orchestration type.
const ORCHESTRATION_TYPE =
  /^\s*type\s+[A-Za-z0-9_]*(?:Coordinator|Worker|Actor)\s+(?:struct|interface)\b/u;

// The same declaration inside a grouped `type ( ... )` block, where the `type`
// keyword is on the opening line instead of the declaration line.
const GROUPED_ORCHESTRATION_TYPE =
  /^\s*[A-Za-z0-9_]*(?:Coordinator|Worker|Actor)\s+(?:struct|interface)\b/u;

// Opens a grouped `type ( ... )` declaration block.
const TYPE_GROUP_OPEN = /^\s*type\s*\(/u;

// A production file whose name ends in one of these words is treated as an
// application-core orchestration file.
const ORCHESTRATION_FILENAME = /_(?:coordinator|worker|actor)\.go$/iu;

export function isTestSource(path) {
  return path.endsWith("_test.go");
}

export function isAllowlisted(path) {
  return ALLOWLIST.has(path);
}

export function findBoundaryViolations(path, source) {
  if (isTestSource(path) || isAllowlisted(path)) {
    return [];
  }

  const violations = [];

  for (const forbidden of [
    "type serviceHostStore struct",
    "type serviceHostRuntime struct",
    "func NewApplicationHost("
  ]) {
    if (source.includes(forbidden)) {
      violations.push(
        `${path}: production adapter must not reintroduce ${forbidden}; use shared Host composition ports`
      );
    }
  }

  if (ORCHESTRATION_FILENAME.test(path)) {
    violations.push(
      `${path}: filename declares an agent application-core orchestration surface ` +
        `(*Coordinator/*Worker/*Actor). Move session/turn/goal/runtime-operation ` +
        `lifecycle into packages/agent/host and keep only delegate/adapter code here.`
    );
  }

  // Track grouped `type ( ... )` blocks so declarations inside them are
  // checked too. `braceDepth` keeps struct/interface bodies (and their fields)
  // from being treated as top-level declarations of the group.
  let inTypeGroup = false;
  let braceDepth = 0;

  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (ORCHESTRATION_TYPE.test(line)) {
      violations.push(`${path}:${index + 1}: ${line.trim()}`);
      continue;
    }

    if (inTypeGroup) {
      if (braceDepth === 0) {
        if (/^\s*\)/u.test(line)) {
          inTypeGroup = false;
          continue;
        }
        if (GROUPED_ORCHESTRATION_TYPE.test(line)) {
          violations.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      }
      braceDepth += countUnquotedBraces(line);
      continue;
    }

    if (TYPE_GROUP_OPEN.test(line)) {
      inTypeGroup = true;
      braceDepth = 0;
      const remainder = line.slice(line.indexOf("(") + 1);
      if (GROUPED_ORCHESTRATION_TYPE.test(remainder)) {
        violations.push(`${path}:${index + 1}: ${line.trim()}`);
      }
      braceDepth += countUnquotedBraces(remainder);
    }
  }

  return violations;
}

function countUnquotedBraces(line) {
  const withoutComments = line.replace(/\/\/.*$/u, "");
  const withoutStrings = withoutComments.replace(
    /"(?:[^"\\]|\\.)*"|`[^`]*`/gu,
    ""
  );
  let depth = 0;
  for (const character of withoutStrings) {
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    }
  }
  return depth;
}

export function findStaleAllowlistEntries(fileExists = existsSync) {
  const stale = [];
  for (const entry of ALLOWLIST) {
    if (!fileExists(join(workspaceRoot, entry))) {
      stale.push(entry);
    }
  }
  return stale;
}

export function findProductionCompositionViolations(source) {
  const required = [
    [
      "agenthostadapter.RuntimeController",
      "production wiring must consume the shared daemon-to-Host runtime adapter"
    ],
    [
      "agenthost.SQLiteWorkspaceStore",
      "production wiring must consume the shared Host canonical SQLite store"
    ],
    [
      "agentservice.NewApplicationHostWithPorts",
      "production wiring must compose Host from the shared runtime and canonical ports"
    ]
  ];
  return required.flatMap(([token, message]) =>
    source.includes(token) ? [] : [`services/tuttid/wiring.go: ${message}`]
  );
}

function scanWorkspace() {
  const violations = [];
  for (const file of goFiles(join(workspaceRoot, scanRoot))) {
    const path = relative(workspaceRoot, file).replaceAll("\\", "/");
    violations.push(
      ...findBoundaryViolations(path, readFileSync(file, "utf8"))
    );
  }
  return violations;
}

function goFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...goFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".go")) {
      result.push(path);
    }
  }
  return result;
}

function isMainModule() {
  return Boolean(process.argv[1] && resolve(process.argv[1]) === scriptPath);
}

if (isMainModule()) {
  const stale = findStaleAllowlistEntries();
  if (stale.length > 0) {
    console.error(
      "Agent Host boundary allowlist has stale entries. Remove files that no " +
        "longer exist so the ratchet cannot hide removed seams:\n" +
        stale.join("\n")
    );
    process.exitCode = 1;
  }

  const violations = scanWorkspace();
  const wiringSource = [
    "services/tuttid/wiring.go",
    "services/tuttid/wiring_daemon_api.go"
  ]
    .map((file) => readFileSync(join(workspaceRoot, file), "utf8"))
    .join("\n");
  violations.push(...findProductionCompositionViolations(wiringSource));
  if (violations.length > 0) {
    console.error(
      "Agent application lifecycle semantics must live in packages/agent/host, " +
        "not in the services/tuttid/service/agent adapter. Remove the new " +
        "*Coordinator/*Worker/*Actor orchestration surface, or, only with a " +
        "reviewed ownership reason, add it to ALLOWLIST in " +
        "tools/scripts/check-agent-host-boundary.mjs:\n" +
        violations.join("\n")
    );
    process.exitCode = 1;
  }
}
