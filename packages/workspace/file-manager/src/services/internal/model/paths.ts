import {
  workspaceFileManagerLogicalRoot,
  type WorkspaceFileEntry
} from "../../workspaceFileManagerTypes.ts";

export function normalizeWorkspaceFilePath(
  value?: string | null,
  rootPath?: string | null
): string {
  const root = normalizeWorkspaceFileAbsolutePath(rootPath);
  const raw = String(value ?? "")
    .trim()
    .replaceAll("\\", "/");
  if (!raw) {
    return root;
  }

  if (!isWorkspaceFileAbsolutePath(raw) && root) {
    return normalizeWorkspaceFileAbsolutePath(`${root}/${raw}`);
  }

  return normalizeWorkspaceFileAbsolutePath(raw);
}

function normalizeWorkspaceFileAbsolutePath(value?: string | null): string {
  const raw = String(value ?? "")
    .trim()
    .replaceAll("\\", "/");
  if (!raw) {
    return workspaceFileManagerLogicalRoot;
  }

  const drive = readWindowsDrive(raw);
  const startsWithSlash = raw.startsWith("/");
  const body = drive
    ? raw.slice(drive.length).replace(/^\/+/, "")
    : startsWithSlash
      ? raw.slice(1)
      : raw;
  const segments = body
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== ".");
  const result: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      result.pop();
      continue;
    }
    result.push(segment);
  }

  if (result.length === 0) {
    return drive ? `${drive}/` : workspaceFileManagerLogicalRoot;
  }
  if (drive) {
    return `${drive}/${result.join("/")}`;
  }
  return `/${result.join("/")}`;
}

export function workspaceFileName(path: string): string {
  return (
    normalizeWorkspaceFilePath(path).split("/").filter(Boolean).at(-1) ??
    "workspace"
  );
}

export function workspaceFileDirectory(
  path: string,
  rootPath?: string | null
): string {
  const root = normalizeWorkspaceFilePath(rootPath);
  const rawPath = String(path ?? "")
    .trim()
    .replaceAll("\\", "/");
  const normalized = normalizeWorkspaceFilePath(path, root);
  if (normalized === root) {
    return root;
  }

  const drive = readWindowsDrive(normalized);
  const body = drive ? normalized.slice(drive.length) : normalized;
  const parts = body.split("/").filter(Boolean);
  parts.pop();
  const directory = drive
    ? parts.length === 0
      ? `${drive}/`
      : `${drive}/${parts.join("/")}`
    : parts.length === 0
      ? workspaceFileManagerLogicalRoot
      : `/${parts.join("/")}`;
  if (root !== workspaceFileManagerLogicalRoot) {
    if (isWorkspaceFilePathWithinRoot(directory, root)) {
      return directory;
    }
    return isWorkspaceFileAbsolutePath(rawPath) ? directory : root;
  }
  return directory;
}

export function isHiddenWorkspaceDirectoryEntry(
  entry: WorkspaceFileEntry
): boolean {
  return entry.kind === "directory" && entry.name.startsWith(".");
}

export function workspaceFilePathHasHiddenSegment(path: string): boolean {
  return normalizeWorkspaceFilePath(path)
    .split("/")
    .filter(Boolean)
    .some((segment) => segment.startsWith("."));
}

export function filterVisibleWorkspaceEntries(
  entries: WorkspaceFileEntry[]
): WorkspaceFileEntry[] {
  return entries.filter((entry) => !isHiddenWorkspaceDirectoryEntry(entry));
}

export function sortWorkspaceEntries(
  entries: WorkspaceFileEntry[]
): WorkspaceFileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: "base"
    });
  });
}

export function buildWorkspaceFileBreadcrumbs(
  path: string,
  rootLabel: string,
  rootPath?: string | null
): Array<{ label: string; path: string }> {
  const root = normalizeWorkspaceFilePath(rootPath);
  const current = normalizeWorkspaceFilePath(path, root);

  // Package placeholder root is "/". Hosts like TSH keep logical paths under
  // "/workspace" before listing.root arrives. Splitting "/workspace" under
  // "/" yields a duplicate crumb: "workspace" / "workspace".
  if (
    root === workspaceFileManagerLogicalRoot &&
    current !== workspaceFileManagerLogicalRoot
  ) {
    return [{ label: rootLabel, path: current }];
  }

  const relative =
    current === root ? "" : current.slice(root.length).replace(/^\//, "");
  const breadcrumbs: Array<{ label: string; path: string }> = [
    { label: rootLabel, path: root }
  ];
  let cursor = root;
  for (const segment of relative.split("/").filter(Boolean)) {
    cursor = `${cursor}/${segment}`.replace(/\/+/g, "/");
    breadcrumbs.push({ label: segment, path: cursor });
  }
  return breadcrumbs;
}

export function isWorkspaceFilePathWithinRoot(
  path: string,
  rootPath?: string | null
): boolean {
  const root = normalizeWorkspaceFilePath(rootPath);
  const normalized = normalizeWorkspaceFilePath(path, root);
  const comparison =
    readWindowsDrive(root) || readWindowsDrive(normalized)
      ? { normalized: normalized.toLowerCase(), root: root.toLowerCase() }
      : { normalized, root };
  return (
    comparison.root === workspaceFileManagerLogicalRoot ||
    comparison.normalized === comparison.root ||
    comparison.normalized.startsWith(`${comparison.root}/`)
  );
}

function isWorkspaceFileAbsolutePath(path: string): boolean {
  return path.startsWith("/") || readWindowsDrive(path) !== "";
}

function readWindowsDrive(path: string): string {
  return /^[A-Za-z]:/.exec(path)?.[0] ?? "";
}
