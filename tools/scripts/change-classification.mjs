import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { createIsolatedGitEnvironment } from "./git-environment.mjs";
import { selectedRepositoryCheckGroups } from "./repository-checks.mjs";
import { isGoValidationRelevant } from "./run-check-changed-targets.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "../..");

export function classifyChangedFiles(
  changedFiles,
  {
    isPackageManifestPackRelevant = () => true,
    isRootManifestTestRelevant = () => true,
    releasePackages = discoverReleasePackages(),
    workspacePackages = discoverWorkspacePackages()
  } = {}
) {
  const normalizedFiles = changedFiles.map((file) =>
    file.replaceAll("\\", "/")
  );
  const groups = selectedRepositoryCheckGroups(normalizedFiles);
  const packSelection = selectPackPackages(normalizedFiles, {
    isPackageManifestPackRelevant,
    releasePackages
  });
  const testSelection = selectTypeScriptTestPackages(normalizedFiles, {
    isRootManifestTestRelevant,
    workspacePackages
  });
  const testShards = buildTypeScriptTestShards(testSelection.packageNames);

  return {
    buildWindowsInstaller: normalizedFiles.some(
      isWindowsDesktopInstallerRelevant
    ),
    packAll: packSelection.packAll,
    packPackages: packSelection.packageNames,
    runAgentSessionReplay: normalizedFiles.some(isAgentSessionReplayRelevant),
    runBoundaries: groups.has("boundaries"),
    runContracts: groups.has("contracts"),
    runGenerated: groups.has("generated"),
    runGo: normalizedFiles.some(isGoValidationRelevant),
    runPack: packSelection.packAll || packSelection.packageNames.length > 0,
    runTs: normalizedFiles.some(isTypeScriptRelevant),
    runTsTests: testSelection.testAll || testSelection.packageNames.length > 0,
    testAll: testSelection.testAll,
    testPackages: testSelection.packageNames,
    testShards
  };
}

export function discoverWorkspacePackages(root = workspaceRoot) {
  const packageRoots = [
    ...readChildPackageRoots(join(root, "apps")),
    ...readGrandchildPackageRoots(join(root, "packages")),
    ...readChildPackageRoots(join(root, "services/tuttid/builtin-apps")),
    ...readChildPackageRoots(join(root, "tools/fixtures"))
  ];
  const packages = [];

  for (const packageRoot of packageRoots) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8")
      );
      if (typeof manifest.name === "string") {
        packages.push({
          hasTests: typeof manifest.scripts?.test === "string",
          manifest,
          name: manifest.name,
          root: packageRoot.slice(root.length + 1).replaceAll("\\", "/")
        });
      }
    } catch {
      // Non-package directories are outside the workspace package surface.
    }
  }

  const workspaceNames = new Set(
    packages.map((packageConfig) => packageConfig.name)
  );
  return packages
    .map(({ manifest, ...packageConfig }) => ({
      ...packageConfig,
      workspaceDependencies: Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies
      })
        .filter((name) => workspaceNames.has(name))
        .sort()
    }))
    .sort((left, right) => left.root.localeCompare(right.root));
}

export function discoverReleasePackages(root = workspaceRoot) {
  const packagesRoot = join(root, "packages");
  const packages = [];

  for (const group of readDirectories(packagesRoot)) {
    const groupRoot = join(packagesRoot, group);
    for (const packageName of readDirectories(groupRoot)) {
      const packageRoot = join(groupRoot, packageName);
      const manifestPath = join(packageRoot, "package.json");
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (
          manifest.private === false &&
          manifest.publishConfig?.access === "public"
        ) {
          packages.push({
            name: manifest.name,
            root: packageRoot.slice(root.length + 1).replaceAll("\\", "/")
          });
        }
      } catch {
        // Non-package directories are outside the release surface.
      }
    }
  }

  return packages.sort((left, right) => left.root.localeCompare(right.root));
}

export function formatClassificationOutputs(classification) {
  return [
    ["build_windows_installer", classification.buildWindowsInstaller],
    ["pack_all", classification.packAll],
    ["pack_packages", JSON.stringify(classification.packPackages)],
    ["run_agent_session_replay", classification.runAgentSessionReplay],
    ["run_boundaries", classification.runBoundaries],
    ["run_contracts", classification.runContracts],
    ["run_generated", classification.runGenerated],
    ["run_go", classification.runGo],
    ["run_pack", classification.runPack],
    ["run_ts", classification.runTs],
    ["run_ts_tests", classification.runTsTests],
    ["test_all", classification.testAll],
    ["test_packages", JSON.stringify(classification.testPackages)],
    ["test_shards", JSON.stringify(classification.testShards)]
  ]
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function isWindowsDesktopInstallerRelevant(file) {
  return (
    ["package.json", "pnpm-lock.yaml"].includes(file) ||
    file === "config/tutti.app-runtime.lock.json" ||
    file === "apps/desktop/package.json" ||
    file.startsWith("apps/desktop/build/") ||
    file.startsWith("apps/desktop/scripts/") ||
    file.startsWith("services/tuttid/builtin-apps/")
  );
}

export function buildTypeScriptTestShards(packageNames, maximum = 3) {
  const shardCount = Math.max(1, Math.min(maximum, packageNames.length));
  return Array.from(
    { length: shardCount },
    (_, index) => `${index + 1}/${shardCount}`
  );
}

export function isAgentSessionReplayRelevant(file) {
  return (
    file === "package.json" ||
    file === "pnpm-lock.yaml" ||
    file === "apps/desktop/package.json" ||
    file === "apps/desktop/electron.vite.config.ts" ||
    file === "config/tutti.defaults.json" ||
    file.startsWith("tools/scripts/run-agent-session-replay") ||
    file === "tools/scripts/fixtures/agent-gui-performance/cursor-agent" ||
    file.startsWith("packages/agent/session-replay/") ||
    file.startsWith("packages/agent/daemon/providerregistry/") ||
    file.startsWith("packages/agent/daemon/runtime/") ||
    file.startsWith(
      "apps/desktop/src/renderer/src/features/agent-session-replay/"
    ) ||
    file.startsWith("apps/desktop/src/main/agentSessionReplay") ||
    file.startsWith("apps/desktop/src/main/daemon/") ||
    file.startsWith("apps/desktop/src/preload/") ||
    file === "apps/desktop/src/main/desktopAppLifecycle.ts" ||
    file === "apps/desktop/src/shared/contracts/ipc.ts" ||
    file.startsWith("services/tuttid/service/agentsessionreplay/") ||
    file.startsWith("services/tuttid/data/agentsessionreplay/") ||
    /services\/tuttid\/(?:agent_process_cassette|agent_replay_composition|agent_session_recording)\S*\.go$/u.test(
      file
    ) ||
    /services\/tuttid\/api\/\S*agent_session_(?:recording|replay)\S*\.go$/u.test(
      file
    ) ||
    /services\/tuttid\/data\/workspace\/\S*agent_session_(?:fixture|replay)\S*\.go$/u.test(
      file
    )
  );
}

function isTypeScriptRelevant(file) {
  return (
    /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(file) ||
    /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$/u.test(file) ||
    ["pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file) ||
    file.startsWith("packages/configs/")
  );
}

export function selectTypeScriptTestPackages(
  files,
  { isRootManifestTestRelevant, workspacePackages }
) {
  const testPackages = workspacePackages.filter(
    (packageConfig) => packageConfig.hasTests
  );
  const testAll =
    files.some(isGlobalTypeScriptTestRelevant) ||
    (files.includes("package.json") && isRootManifestTestRelevant());
  if (testAll) {
    return {
      packageNames: testPackages.map((packageConfig) => packageConfig.name),
      testAll: true
    };
  }

  const affectedPackageNames = new Set();
  for (const file of files) {
    const packageConfig = workspacePackages.find(
      ({ root }) => file === root || file.startsWith(`${root}/`)
    );
    if (packageConfig) {
      affectedPackageNames.add(packageConfig.name);
      continue;
    }
    if (
      /^(?:apps\/[^/]+|packages\/[^/]+\/[^/]+|services\/tuttid\/builtin-apps\/[^/]+|tools\/fixtures\/[^/]+)\/package\.json$/u.test(
        file
      )
    ) {
      return {
        packageNames: testPackages.map((testPackage) => testPackage.name),
        testAll: true
      };
    }
  }

  addTransitiveWorkspaceDependents(affectedPackageNames, workspacePackages);
  return {
    packageNames: testPackages
      .filter((packageConfig) => affectedPackageNames.has(packageConfig.name))
      .map((packageConfig) => packageConfig.name),
    testAll: false
  };
}

function addTransitiveWorkspaceDependents(affectedPackageNames, packages) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const packageConfig of packages) {
      if (
        !affectedPackageNames.has(packageConfig.name) &&
        (packageConfig.workspaceDependencies ?? []).some((name) =>
          affectedPackageNames.has(name)
        )
      ) {
        affectedPackageNames.add(packageConfig.name);
        changed = true;
      }
    }
  }
}

function isGlobalTypeScriptTestRelevant(file) {
  return (
    [".node-version", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file) ||
    file.startsWith("packages/configs/") ||
    [
      "tools/scripts/run-validation-lanes.mjs",
      "tools/scripts/run-workspace-tests.mjs"
    ].includes(file)
  );
}

function selectPackPackages(
  files,
  { isPackageManifestPackRelevant, releasePackages }
) {
  const packAll = files.some((file) => isGlobalPackRelevant(file));
  if (packAll) {
    return {
      packAll: true,
      packageNames: releasePackages.map((packageConfig) => packageConfig.name)
    };
  }

  const packageNames = new Set();
  for (const file of files) {
    const packageConfig = releasePackages.find(
      ({ root }) => file === root || file.startsWith(`${root}/`)
    );

    if (!packageConfig) {
      if (/^packages\/[^/]+\/[^/]+\/package\.json$/u.test(file)) {
        return {
          packAll: true,
          packageNames: releasePackages.map(
            (releasePackage) => releasePackage.name
          )
        };
      }
      continue;
    }

    const relativePath = file.slice(packageConfig.root.length + 1);
    if (relativePath === "package.json") {
      if (!isPackageManifestPackRelevant(file)) {
        continue;
      }
      return {
        packAll: true,
        packageNames: releasePackages.map(
          (releasePackage) => releasePackage.name
        )
      };
    }
    if (isPackagePackRelevantPath(relativePath)) {
      packageNames.add(packageConfig.name);
    }
  }

  return {
    packAll: false,
    packageNames: [...packageNames].sort()
  };
}

function isGlobalPackRelevant(file) {
  return (
    ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file) ||
    file === ".changeset/config.json" ||
    file === "tools/scripts/build-npm-packages.mjs" ||
    file === "tools/scripts/check-package-packs.mjs" ||
    file === "tools/scripts/npm-release-packages.mjs" ||
    file === "tools/scripts/run-package-pack-check.mjs"
  );
}

export function isPackagePackRelevantPath(file) {
  return !(
    /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(file) ||
    /^vitest(?:\.[^/]+)*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(
      basename(file)
    )
  );
}

export function createPackageManifestPackRelevance({
  baseRef,
  headRef = "HEAD",
  root = workspaceRoot
}) {
  const cache = new Map();

  return (file) => {
    if (!cache.has(file)) {
      cache.set(
        file,
        isPackageManifestPackRelevant(baseRef, headRef, file, root)
      );
    }
    return cache.get(file);
  };
}

export function createRootManifestTestRelevance({
  baseRef,
  headRef = "HEAD",
  root = workspaceRoot
}) {
  return () => {
    try {
      const before = normalizedManifestAtRef(
        baseRef,
        "package.json",
        root,
        testRelevantRootManifest
      );
      const candidates = [
        normalizedManifestAtRef(
          headRef,
          "package.json",
          root,
          testRelevantRootManifest
        )
      ];
      if (headRef === "HEAD") {
        candidates.push(
          JSON.stringify(
            testRelevantRootManifest(
              JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
            )
          )
        );
      }
      return candidates.some((candidate) => candidate !== before);
    } catch {
      return true;
    }
  };
}

function isPackageManifestPackRelevant(baseRef, headRef, file, root) {
  try {
    const before = normalizedManifestAtRef(baseRef, file, root);
    const candidates = [normalizedManifestAtRef(headRef, file, root)];
    if (headRef === "HEAD") {
      candidates.push(
        JSON.stringify(
          withoutTestScripts(JSON.parse(readFileSync(join(root, file), "utf8")))
        )
      );
    }
    return candidates.some((candidate) => candidate !== before);
  } catch {
    return true;
  }
}

function normalizedManifestAtRef(
  ref,
  file,
  root,
  normalize = withoutTestScripts
) {
  const manifest = JSON.parse(
    execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: root,
      encoding: "utf8",
      env: createIsolatedGitEnvironment(root)
    })
  );
  return JSON.stringify(normalize(manifest));
}

function withoutTestScripts(manifest) {
  const normalized = structuredClone(manifest);
  if (!normalized.scripts || typeof normalized.scripts !== "object") {
    return normalized;
  }

  for (const name of Object.keys(normalized.scripts)) {
    if (/^(?:pre|post)?test(?::|$)/u.test(name)) {
      delete normalized.scripts[name];
    }
  }
  if (Object.keys(normalized.scripts).length === 0) {
    delete normalized.scripts;
  }
  return normalized;
}

function testRelevantRootManifest(manifest) {
  const relevant = {};
  for (const key of [
    "dependencies",
    "devDependencies",
    "engines",
    "optionalDependencies",
    "packageManager",
    "peerDependencies",
    "pnpm",
    "workspaces"
  ]) {
    if (manifest[key] !== undefined) {
      relevant[key] = manifest[key];
    }
  }

  const scripts = Object.fromEntries(
    Object.entries(manifest.scripts ?? {}).filter(([name]) =>
      /^(?:preinstall|install|postinstall|prepare|(?:pre|post)?test:ts(?::.*)?)$/u.test(
        name
      )
    )
  );
  if (Object.keys(scripts).length > 0) {
    relevant.scripts = scripts;
  }
  return relevant;
}

function readChildPackageRoots(root) {
  return readDirectories(root).map((name) => join(root, name));
}

function readGrandchildPackageRoots(root) {
  return readDirectories(root).flatMap((group) =>
    readChildPackageRoots(join(root, group))
  );
}

function readDirectories(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  const base = readOption("--base");
  if (!base) {
    throw new Error("--base is required");
  }
  const head = readOption("--head") ?? "HEAD";
  const changedFiles = execFileSync(
    "git",
    ["diff", "--name-only", `${base}...${head}`],
    { cwd: workspaceRoot, encoding: "utf8" }
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const output = formatClassificationOutputs(
    classifyChangedFiles(changedFiles, {
      isPackageManifestPackRelevant: createPackageManifestPackRelevance({
        baseRef: base,
        headRef: head
      }),
      isRootManifestTestRelevant: createRootManifestTestRelevance({
        baseRef: base,
        headRef: head
      })
    })
  );
  const githubOutput = readOption("--github-output");
  if (githubOutput) {
    writeFileSync(githubOutput, `${output}\n`, { flag: "a" });
  }
  console.log(output);
}
