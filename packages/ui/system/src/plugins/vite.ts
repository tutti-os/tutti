import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin, ViteDevServer } from "vite";
import { WebSocket } from "ws";

import type {
  UISystemDevEvent,
  UISystemDevFile,
  UISystemDevManifest
} from "../dev-server/protocol.js";

export type TuttiUISystemDevOptions = {
  serverUrl?: string;
  cacheDir?: string;
};

const defaultServerUrl = "http://127.0.0.1:4100";
const defaultCacheDir = ".tutti-ui-system-dev";
const cacheMarkerFileName = ".tutti-ui-system-dev-cache";
const packageName = "@tutti-os/ui-system";
const packageRequire = createRequire(import.meta.url);
const stableEntrypoints = [
  ".",
  "./components",
  "./icons",
  "./native",
  "./native.css",
  "./styles.css",
  "./utils"
] as const;
const packageDependencyAliases = [
  "class-variance-authority",
  "clsx",
  "radix-ui",
  "react-resizable-panels",
  "tailwind-merge"
] as const;
const packageStyleDependencyAliases = ["tw-animate-css"] as const;
const packageDependencyAliasSet = new Set<string>(packageDependencyAliases);
const packageStyleDependencyAliasSet = new Set<string>(
  packageStyleDependencyAliases
);

type StableEntrypoint = (typeof stableEntrypoints)[number];
type DevSyncState = {
  cacheRoot: string;
  realCacheRoot: string;
  serverUrl: URL;
};

export function tuttiUISystemDev(
  options: TuttiUISystemDevOptions = {}
): Plugin {
  const serverUrl = normalizeServerUrl(options.serverUrl ?? defaultServerUrl);
  const cacheDir = options.cacheDir ?? defaultCacheDir;
  let syncState: DevSyncState | null = null;

  return {
    name: "tutti-ui-system-dev",
    async config(config, env) {
      if (env.command !== "serve") {
        syncState = null;
        return {};
      }

      if (!(await probeHealth(serverUrl))) {
        syncState = null;
        return {};
      }

      const projectRoot = path.resolve(config.root ?? process.cwd());
      const cacheState = await prepareCacheRoot(projectRoot, cacheDir);
      const manifest = await fetchJson<UISystemDevManifest>(
        serverUrl,
        "/manifest"
      );

      validateManifest(manifest);
      await syncFiles(serverUrl, cacheState);
      await fetchComponentsMetadata(serverUrl);
      syncState = { ...cacheState, serverUrl };

      return {
        resolve: {
          alias: stableEntrypoints
            .map((entrypoint) => ({
              find: entrypointAlias(entrypoint),
              replacement: path.join(
                cacheState.cacheRoot,
                manifest.entrypoints[entrypoint]
              )
            }))
            .concat(
              packageStyleDependencyAliases.map((dependencyName) => ({
                find: dependencyAlias(dependencyName),
                replacement: dependencyName,
                customResolver: (
                  _source: string,
                  importer: string | undefined
                ) =>
                  isCacheImporter(syncState, importer)
                    ? resolvePackageStyleDependency(dependencyName)
                    : null
              }))
            )
        }
      };
    },
    async resolveId(source, importer) {
      if (syncState === null || !isCacheImporter(syncState, importer)) {
        return null;
      }

      if (packageDependencyAliasSet.has(source)) {
        return packageRequire.resolve(source);
      }

      if (packageStyleDependencyAliasSet.has(source)) {
        const resolved = await this.resolve(source, packageContextImporter(), {
          skipSelf: true
        });

        return resolved?.id ?? null;
      }

      return null;
    },
    configureServer(server) {
      if (syncState === null) {
        return;
      }

      subscribeToEvents(server, syncState);
    }
  };
}

async function probeHealth(serverUrl: URL): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", serverUrl));

    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as { packageName?: unknown };

    return payload.packageName === packageName;
  } catch {
    return false;
  }
}

async function syncFiles(
  serverUrl: URL,
  cacheState: Pick<DevSyncState, "cacheRoot" | "realCacheRoot">
): Promise<void> {
  const files = await fetchJson<UISystemDevFile[]>(serverUrl, "/files");

  if (!Array.isArray(files)) {
    throw new Error(
      "@tutti-os/ui-system dev server returned invalid files list"
    );
  }

  const syncPaths = new Set<string>();

  await Promise.all(
    files.map(async (file) => {
      validateSyncFile(file);
      syncPaths.add(file.path);

      const destination = resolveCacheFile(cacheState.cacheRoot, file.path);
      await prepareCacheFileTarget(cacheState, destination);

      const currentHash = await readCachedHash(destination);

      if (currentHash === file.hash) {
        return;
      }

      const bytes = await fetchFile(serverUrl, file.path);
      const downloadedHash = hashBytes(bytes);

      if (downloadedHash !== file.hash) {
        throw new Error(
          `Hash mismatch while syncing @tutti-os/ui-system file: ${file.path}`
        );
      }

      await writeFile(destination, bytes);
    })
  );

  await removeStaleCacheFiles(cacheState, syncPaths);
}

async function syncChangedFile(
  server: ViteDevServer,
  state: DevSyncState,
  event: Extract<UISystemDevEvent, { type: "fileChanged" }>
): Promise<void> {
  validateEventPath(event.path);

  const destination = resolveCacheFile(state.cacheRoot, event.path);
  await prepareCacheFileTarget(state, destination);

  const bytes = await fetchFile(state.serverUrl, event.path);
  const downloadedHash = hashBytes(bytes);

  if (downloadedHash !== event.hash) {
    throw new Error(
      `Hash mismatch while syncing @tutti-os/ui-system file: ${event.path}`
    );
  }

  await writeFile(destination, bytes);
  invalidateFile(server, destination);
}

async function removeDeletedFile(
  server: ViteDevServer,
  state: DevSyncState,
  event: Extract<UISystemDevEvent, { type: "fileDeleted" }>
): Promise<void> {
  validateEventPath(event.path);

  const destination = resolveCacheFile(state.cacheRoot, event.path);

  invalidateFile(server, destination);
  await removeCacheFile(state, destination);
}

function subscribeToEvents(server: ViteDevServer, state: DevSyncState): void {
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let websocket: WebSocket | null = null;

  const close = (): void => {
    closed = true;

    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    websocket?.close();
    websocket = null;
  };

  const reconnect = (): void => {
    if (closed || reconnectTimer !== null) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1000);
  };

  const connect = (): void => {
    if (closed) {
      return;
    }

    websocket = new WebSocket(eventUrl(state.serverUrl));

    websocket.on("message", (message) => {
      void handleEventMessage(server, state, message).catch(() => {
        // Event sync is best-effort; the initial HTTP sync remains authoritative.
      });
    });

    websocket.on("close", reconnect);
    websocket.on("error", () => {
      websocket?.close();
    });
  };

  connect();
  server.httpServer?.once("close", close);
}

async function handleEventMessage(
  server: ViteDevServer,
  state: DevSyncState,
  message: WebSocket.RawData
): Promise<void> {
  const event = parseEvent(message);

  if (event === null) {
    return;
  }

  if (event.type === "fileChanged") {
    await syncChangedFile(server, state, event);
    return;
  }

  if (event.type === "fileDeleted") {
    await removeDeletedFile(server, state, event);
  }
}

function parseEvent(message: WebSocket.RawData): UISystemDevEvent | null {
  try {
    const event = JSON.parse(rawMessageToString(message)) as UISystemDevEvent;

    if (!isDevEvent(event)) {
      return null;
    }

    return event;
  } catch {
    return null;
  }
}

function rawMessageToString(message: WebSocket.RawData): string {
  if (Buffer.isBuffer(message)) {
    return message.toString("utf8");
  }

  if (Array.isArray(message)) {
    return Buffer.concat(message).toString("utf8");
  }

  return Buffer.from(message).toString("utf8");
}

function isDevEvent(event: UISystemDevEvent): event is UISystemDevEvent {
  if (event === null || typeof event !== "object") {
    return false;
  }

  if (event.type === "fileChanged") {
    return typeof event.path === "string" && typeof event.hash === "string";
  }

  if (event.type === "fileDeleted") {
    return typeof event.path === "string";
  }

  return event.type === "manifestChanged" || event.type === "componentsChanged";
}

function invalidateFile(server: ViteDevServer, filePath: string): void {
  const modules = server.moduleGraph.getModulesByFile(filePath);

  if (modules === undefined) {
    return;
  }

  for (const moduleNode of modules) {
    server.moduleGraph.invalidateModule(moduleNode);
  }
}

async function fetchComponentsMetadata(serverUrl: URL): Promise<void> {
  try {
    await fetchJson<unknown>(serverUrl, "/components");
  } catch {
    // Component diagnostics are best-effort; source sync and aliases are sufficient.
  }
}

async function fetchJson<T>(serverUrl: URL, endpoint: string): Promise<T> {
  const response = await fetch(new URL(endpoint, serverUrl));

  if (!response.ok) {
    throw new Error(
      `@tutti-os/ui-system dev server ${endpoint} failed with ${response.status}`
    );
  }

  return (await response.json()) as T;
}

async function fetchFile(serverUrl: URL, syncPath: string): Promise<Buffer> {
  const response = await fetch(
    new URL(`/files/${encodeSyncPath(syncPath)}`, serverUrl)
  );

  if (!response.ok) {
    throw new Error(
      `@tutti-os/ui-system dev server file fetch failed for ${syncPath}`
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function readCachedHash(filePath: string): Promise<string | null> {
  try {
    return hashBytes(await readFile(filePath));
  } catch {
    return null;
  }
}

function validateManifest(
  manifest: UISystemDevManifest
): asserts manifest is UISystemDevManifest & {
  entrypoints: Record<StableEntrypoint, string>;
} {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    manifest.packageName !== packageName ||
    typeof manifest.entrypoints !== "object" ||
    manifest.entrypoints === null
  ) {
    throw new Error("@tutti-os/ui-system dev server returned invalid manifest");
  }

  for (const entrypoint of stableEntrypoints) {
    const syncPath = manifest.entrypoints[entrypoint];

    if (typeof syncPath !== "string" || normalizeSyncPath(syncPath) === null) {
      throw new Error(
        `@tutti-os/ui-system dev server manifest is missing ${entrypoint}`
      );
    }
  }
}

function validateSyncFile(file: UISystemDevFile): void {
  if (
    file === null ||
    typeof file !== "object" ||
    typeof file.path !== "string" ||
    typeof file.hash !== "string" ||
    typeof file.size !== "number" ||
    normalizeSyncPath(file.path) === null
  ) {
    throw new Error(
      "@tutti-os/ui-system dev server returned invalid file entry"
    );
  }
}

function validateEventPath(syncPath: string): void {
  if (normalizeSyncPath(syncPath) === null) {
    throw new Error(
      `Refusing unsafe @tutti-os/ui-system event path: ${syncPath}`
    );
  }
}

async function prepareCacheRoot(
  projectRoot: string,
  cacheDir: string
): Promise<Pick<DevSyncState, "cacheRoot" | "realCacheRoot">> {
  const cacheRoot = resolveCacheRoot(projectRoot, cacheDir);

  await ensureNoSymlinkAncestors(projectRoot, path.dirname(cacheRoot));
  await mkdir(cacheRoot, { recursive: true });
  await ensureNoSymlinkAncestors(projectRoot, cacheRoot);

  const cacheStat = await lstat(cacheRoot);

  if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) {
    throw new Error(
      "@tutti-os/ui-system dev cacheDir must be a real directory"
    );
  }

  const realProjectRoot = await realpath(projectRoot);
  const realCacheRoot = await realpath(cacheRoot);

  if (!isPathInside(realProjectRoot, realCacheRoot)) {
    throw new Error(
      "@tutti-os/ui-system dev cacheDir must resolve inside the Vite project root"
    );
  }

  await ensureOwnedCacheRoot(cacheRoot);

  return { cacheRoot, realCacheRoot };
}

function resolveCacheRoot(projectRoot: string, cacheDir: string): string {
  const cacheRoot = path.resolve(projectRoot, cacheDir);
  const relative = path.relative(projectRoot, cacheRoot);

  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "@tutti-os/ui-system dev cacheDir must resolve inside the Vite project root"
    );
  }

  return cacheRoot;
}

async function prepareCacheFileTarget(
  cacheState: Pick<DevSyncState, "cacheRoot" | "realCacheRoot">,
  destination: string
): Promise<void> {
  const parent = path.dirname(destination);

  await ensureNoSymlinkAncestors(cacheState.cacheRoot, parent);
  await mkdir(parent, { recursive: true });
  await ensureNoSymlinkAncestors(cacheState.cacheRoot, parent);

  const realParent = await realpath(parent);

  if (!isPathInside(cacheState.realCacheRoot, realParent)) {
    throw new Error(
      "@tutti-os/ui-system dev cache file resolved outside cacheDir"
    );
  }

  await rejectExistingSymlink(destination);
}

async function removeCacheFile(
  cacheState: Pick<DevSyncState, "cacheRoot" | "realCacheRoot">,
  destination: string
): Promise<void> {
  const parent = path.dirname(destination);

  await ensureNoSymlinkAncestors(cacheState.cacheRoot, parent);

  const realParent = await realpath(parent).catch(() => null);

  if (
    realParent === null ||
    !isPathInside(cacheState.realCacheRoot, realParent)
  ) {
    throw new Error(
      "@tutti-os/ui-system dev cache file resolved outside cacheDir"
    );
  }

  await rejectExistingSymlink(destination);
  await rm(destination, { force: true });
}

async function removeStaleCacheFiles(
  cacheState: Pick<DevSyncState, "cacheRoot" | "realCacheRoot">,
  authoritativePaths: Set<string>
): Promise<void> {
  await ensureOwnedCacheRoot(cacheState.cacheRoot);

  const cachedFiles = await listCacheFiles(cacheState.cacheRoot);

  await Promise.all(
    cachedFiles.map(async (cachedFile) => {
      if (authoritativePaths.has(cachedFile)) {
        return;
      }

      await removeCacheFile(
        cacheState,
        resolveCacheFile(cacheState.cacheRoot, cachedFile)
      );
    })
  );
}

async function listCacheFiles(
  directory: string,
  prefix = ""
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const syncPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = path.join(directory, entry.name);

      if (syncPath === cacheMarkerFileName) {
        return [];
      }

      if (entry.isSymbolicLink()) {
        throw new Error(
          `Refusing symlink in @tutti-os/ui-system dev cache: ${syncPath}`
        );
      }

      if (entry.isDirectory()) {
        return listCacheFiles(absolutePath, syncPath);
      }

      return entry.isFile() ? [syncPath] : [];
    })
  );

  return paths.flat();
}

async function ensureOwnedCacheRoot(cacheRoot: string): Promise<void> {
  const markerPath = path.join(cacheRoot, cacheMarkerFileName);

  try {
    const markerStat = await lstat(markerPath);

    if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
      throw new Error(
        "@tutti-os/ui-system dev cacheDir contains an unsafe ownership marker"
      );
    }

    return;
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const entries = await readdir(cacheRoot);

  if (entries.length > 0) {
    throw new Error(
      "@tutti-os/ui-system dev cacheDir must be empty or contain a Tutti UI cache marker before stale cleanup"
    );
  }

  await writeFile(
    markerPath,
    JSON.stringify({ packageName, cache: "ui-system-dev" }, null, 2)
  );
}

function resolveCacheFile(cacheRoot: string, syncPath: string): string {
  const normalized = normalizeSyncPath(syncPath);

  if (normalized === null) {
    throw new Error(
      `Refusing to sync unsafe @tutti-os/ui-system path: ${syncPath}`
    );
  }

  const destination = path.resolve(cacheRoot, normalized);
  const relative = path.relative(cacheRoot, destination);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to sync @tutti-os/ui-system path: ${syncPath}`);
  }

  return destination;
}

async function ensureNoSymlinkAncestors(
  root: string,
  target: string
): Promise<void> {
  const relative = path.relative(root, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("@tutti-os/ui-system dev cache path escaped cacheDir");
  }

  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = root;

  for (const segment of segments) {
    current = path.join(current, segment);

    try {
      const stat = await lstat(current);

      if (stat.isSymbolicLink()) {
        throw new Error(
          `Refusing symlink in @tutti-os/ui-system dev cache path: ${current}`
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }

      throw error;
    }
  }
}

async function rejectExistingSymlink(filePath: string): Promise<void> {
  try {
    const stat = await lstat(filePath);

    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `Refusing unsafe @tutti-os/ui-system cache file: ${filePath}`
      );
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }

    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function normalizeSyncPath(input: string): string | null {
  if (input.includes("\0")) {
    return null;
  }

  const slashPath = input.replaceAll("\\", "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(slashPath);

  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    return null;
  }

  return normalized;
}

function encodeSyncPath(syncPath: string): string {
  return syncPath.split("/").map(encodeURIComponent).join("/");
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeServerUrl(serverUrl: string): URL {
  return new URL(serverUrl);
}

function eventUrl(serverUrl: URL): string {
  const url = new URL("/events", serverUrl);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.href;
}

function entrypointAlias(entrypoint: StableEntrypoint): RegExp {
  const specifier =
    entrypoint === "." ? packageName : `${packageName}${entrypoint.slice(1)}`;

  return new RegExp(`^${escapeRegExp(specifier)}$`);
}

function isCacheImporter(
  state: DevSyncState | null,
  importer: string | undefined
): boolean {
  if (state === null || importer === undefined) {
    return false;
  }

  const importerPath = stripViteIdQuery(importer);

  if (!path.isAbsolute(importerPath)) {
    return false;
  }

  return isPathInside(state.cacheRoot, path.resolve(importerPath));
}

function stripViteIdQuery(id: string): string {
  const [pathWithoutQuery = ""] = id.split("?", 1);

  return pathWithoutQuery;
}

function packageContextImporter(): string {
  return fileURLToPath(new URL("../styles/index.css", import.meta.url));
}

function resolvePackageStyleDependency(dependencyName: string): string {
  const packageDirectory = findDependencyPackageDirectory(dependencyName);
  const manifest = JSON.parse(
    readFileSync(path.join(packageDirectory, "package.json"), "utf8")
  ) as {
    exports?: {
      "."?: {
        style?: unknown;
      };
    };
  };
  const styleExport = manifest.exports?.["."]?.style;

  if (typeof styleExport !== "string") {
    throw new Error(`${dependencyName} does not expose a style export`);
  }

  return path.join(packageDirectory, styleExport);
}

function findDependencyPackageDirectory(dependencyName: string): string {
  const searchPaths = packageRequire.resolve.paths(dependencyName) ?? [];

  for (const searchPath of searchPaths) {
    const packageDirectory = path.join(searchPath, dependencyName);

    try {
      const manifest = JSON.parse(
        readFileSync(path.join(packageDirectory, "package.json"), "utf8")
      ) as { name?: unknown };

      if (manifest.name === dependencyName) {
        return packageDirectory;
      }
    } catch {
      // Try the next Node resolution search path.
    }
  }

  throw new Error(`Could not resolve ${dependencyName} from ${packageName}`);
}

function dependencyAlias(dependencyName: string): RegExp {
  return new RegExp(`^${escapeRegExp(dependencyName)}$`);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
