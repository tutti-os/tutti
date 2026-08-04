import path from "node:path";

export const workspaceLogicalRoot = "/workspace" as const;

export function resolveWorkspaceLogicalFilePath(input: {
  logicalPath: string;
  logicalRoot?: string;
  physicalRootDirectory: string;
}): string {
  const physicalRoot = path.resolve(input.physicalRootDirectory);
  const logicalRoot = normalizeWorkspaceLogicalRoot(input.logicalRoot);
  const rawPath = input.logicalPath.trim().replaceAll("\\", "/");
  if (rawPath === logicalRoot || rawPath.startsWith(`${logicalRoot}/`)) {
    const relative =
      rawPath === logicalRoot ? "" : rawPath.slice(logicalRoot.length + 1);
    const candidate = path.resolve(physicalRoot, relative);
    if (!isPathWithinRoot(physicalRoot, candidate)) {
      throw new Error(
        `workspace file path escapes root directory: ${candidate}`
      );
    }
    return candidate;
  }

  return resolveWorkspaceFileAbsolutePath({
    logicalPath: input.logicalPath,
    rootDirectory: physicalRoot
  });
}

export function resolveWorkspaceFileAbsolutePath(input: {
  logicalPath: string;
  rootDirectory: string;
}): string {
  const rootDirectoryInput = input.rootDirectory.trim();
  if (!rootDirectoryInput) {
    throw new Error("root directory is required");
  }
  const rootDirectory = path.resolve(rootDirectoryInput);
  const rawPath = normalizeWindowsDriveAbsolutePath(
    input.logicalPath.trim().replaceAll("\\", "/")
  );

  const absolutePath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(rootDirectory, rawPath);

  if (!isPathWithinRoot(rootDirectory, absolutePath)) {
    throw new Error(
      `workspace file path escapes root directory: ${absolutePath}`
    );
  }

  return absolutePath;
}

function normalizeWindowsDriveAbsolutePath(value: string): string {
  if (path.sep !== "\\") {
    return value;
  }

  // The daemon exposes Windows absolute paths in POSIX form (`/C:/...`) so
  // they can travel through the logical workspace API. Node's win32 resolver
  // treats that leading slash as the current drive root and produces
  // `C:\\C:\\...`, which then looks like an escape from the workspace root.
  return value.replace(/^\/([A-Za-z]:)(?=\/|$)/, "$1");
}

export function resolveTerminalLinkAbsolutePath(input: {
  cwd?: string | null;
  defaultDirectory: string;
  homeDirectory: string;
  path: string;
}): string {
  const rawPath = input.path.trim();
  if (rawPath === "") {
    throw new Error("terminal link path is required");
  }

  if (rawPath === "~" || rawPath.startsWith("~/")) {
    const relativeHomePath = rawPath === "~" ? "" : rawPath.slice(2);
    return path.resolve(input.homeDirectory, relativeHomePath);
  }

  const normalized = rawPath.replaceAll("\\", "/");
  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }

  const cwd = input.cwd?.trim();
  if (cwd) {
    return path.resolve(cwd, normalized);
  }

  return path.resolve(input.defaultDirectory, normalized);
}

function normalizeWorkspaceLogicalRoot(value?: string): string {
  const raw = String(value ?? workspaceLogicalRoot)
    .trim()
    .replaceAll("\\", "/");
  if (!raw || raw === "/") {
    return workspaceLogicalRoot;
  }
  return raw.startsWith("/") ? raw.replace(/\/+$/, "") || "/" : `/${raw}`;
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  if (relative === "") {
    return true;
  }

  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
