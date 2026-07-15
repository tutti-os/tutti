import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = new URL("..", import.meta.url);
const workspaceRoot = new URL("../../../../", import.meta.url);
const distRoot = new URL("dist/", packageRoot);

for (const path of await listFiles(distRoot, ".js")) {
  const runtime = await readFile(new URL(path, distRoot), "utf8");
  if (/(?:from\s+|import\s*)["']react(?:\/[^"']*)?["']/.test(runtime)) {
    throw new Error(
      `@tutti-os/workbench-host emitted a React runtime import: ${path}`
    );
  }
  if (
    /(?:from\s+|import\s*)["']@tutti-os\/workbench-surface["']/.test(runtime)
  ) {
    throw new Error(
      `@tutti-os/workbench-host emitted a Workbench surface runtime import: ${path}`
    );
  }
}

const surfaceRoot = new URL("packages/workbench/surface/", workspaceRoot);
for (const path of await listFiles(surfaceRoot, ".json", ".ts", ".tsx")) {
  const source = await readFile(new URL(path, surfaceRoot), "utf8");
  if (source.includes("@tutti-os/workbench-host")) {
    throw new Error(
      `@tutti-os/workbench-surface must not depend on host: ${path}`
    );
  }
}

await assertNoSurfaceHostDependencyCycle();

console.log("workbench host built boundary check passed");

async function assertNoSurfaceHostDependencyCycle() {
  const packageManifests = new Map();
  const packagesRoot = new URL("packages/", workspaceRoot);
  for (const group of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) {
      continue;
    }
    const groupRoot = new URL(`${group.name}/`, packagesRoot);
    for (const packageEntry of await readdir(groupRoot, {
      withFileTypes: true
    })) {
      if (!packageEntry.isDirectory()) {
        continue;
      }
      try {
        const manifest = JSON.parse(
          await readFile(
            new URL(`${packageEntry.name}/package.json`, groupRoot),
            "utf8"
          )
        );
        if (typeof manifest.name === "string") {
          packageManifests.set(manifest.name, manifest);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  const pending = [
    {
      name: "@tutti-os/workbench-surface",
      path: ["@tutti-os/workbench-surface"]
    }
  ];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current.name)) {
      continue;
    }
    visited.add(current.name);
    const manifest = packageManifests.get(current.name);
    if (!manifest) {
      continue;
    }
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies"
    ]) {
      for (const dependencyName of Object.keys(manifest[field] ?? {})) {
        if (dependencyName === "@tutti-os/workbench-host") {
          throw new Error(
            `Workbench package dependency cycle: ${[
              ...current.path,
              dependencyName
            ].join(" -> ")}`
          );
        }
        if (packageManifests.has(dependencyName)) {
          pending.push({
            name: dependencyName,
            path: [...current.path, dependencyName]
          });
        }
      }
    }
  }
}

async function listFiles(root, ...extensions) {
  const paths = [];
  await visit("");
  return paths;

  async function visit(relativeDirectory) {
    const entries = await readdir(new URL(relativeDirectory, root), {
      withFileTypes: true
    });
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(`${relativePath}/`);
      } else if (
        extensions.some((extension) => entry.name.endsWith(extension))
      ) {
        paths.push(relativePath);
      }
    }
  }
}
