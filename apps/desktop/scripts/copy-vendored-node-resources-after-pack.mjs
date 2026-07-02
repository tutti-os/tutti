import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(__dirname, "..");

function log(message) {
  process.stderr.write(`[copy-vendored-node-resources] ${message}\n`);
}

function resourcesDirForContext(context) {
  if (context.electronPlatformName === "darwin") {
    const appDir = readdirSync(context.appOutDir).find((entry) =>
      entry.endsWith(".app")
    );
    if (!appDir) {
      throw new Error(`macOS app bundle not found in ${context.appOutDir}`);
    }
    return join(context.appOutDir, appDir, "Contents", "Resources");
  }
  return join(context.appOutDir, "resources");
}

function copyNodeModules(resourcesDir, bundleName) {
  const source = join(desktopDir, "build", bundleName, "node_modules");
  if (!existsSync(source)) {
    throw new Error(`vendored node_modules missing: ${source}`);
  }
  const destination = join(resourcesDir, "bin", bundleName, "node_modules");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true });
  rmSync(join(destination, ".bin"), { recursive: true, force: true });
  removeSymlinks(destination);
  log(`copied ${bundleName} node_modules to ${destination}`);
}

function removeSymlinks(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      rmSync(path, { force: true });
      continue;
    }
    if (stat.isDirectory()) {
      removeSymlinks(path);
    }
  }
}

export default async function copyVendoredNodeResourcesAfterPack(context) {
  const resourcesDir = resourcesDirForContext(context);
  copyNodeModules(resourcesDir, "browser-mcp");
  copyNodeModules(resourcesDir, "claude-sdk-sidecar");
}
