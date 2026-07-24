import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface WorkbenchDockPreviewCacheKey {
  instanceId: string;
  instanceKey?: string | null;
  nodeId: string;
  revision?: string | null;
  typeId: string;
  workspaceId: string;
}

export interface WorkbenchDockPreviewWriteInput {
  dataUrl: string;
  key: WorkbenchDockPreviewCacheKey;
}

export interface WorkbenchDockPreviewCacheStore {
  read(key: WorkbenchDockPreviewCacheKey): Promise<string | null>;
  write(input: WorkbenchDockPreviewWriteInput): Promise<boolean>;
}

export interface WorkbenchDockPreviewCacheStoreOptions {
  directory: string;
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

interface WorkbenchDockPreviewCacheIndexEntry {
  byteLength: number;
  file: string;
  mimeType: WorkbenchDockPreviewMimeType;
  updatedAtUnixMs: number;
}

interface WorkbenchDockPreviewCacheIndex {
  entries: Record<string, WorkbenchDockPreviewCacheIndexEntry>;
  version: 1;
}

type WorkbenchDockPreviewMimeType = "image/jpeg" | "image/png" | "image/webp";

const indexFileName = "index.json";
const defaultMaxEntries = 200;
const defaultMaxEntryBytes = 80 * 1024;
const defaultMaxTotalBytes = 20 * 1024 * 1024;
const maxCacheKeyPartLength = 1024;
const maxCacheKeyTotalLength = 4096;
const sha256Pattern = /^[a-f0-9]{64}$/u;
let temporaryFileSequence = 0;

export function createWorkbenchDockPreviewCacheStore(
  options: WorkbenchDockPreviewCacheStoreOptions
): WorkbenchDockPreviewCacheStore {
  const directory = requireDirectory(options.directory);
  const indexPath = path.join(directory, indexFileName);
  const maxEntries = positiveIntegerOrDefault(
    options.maxEntries,
    defaultMaxEntries
  );
  const maxEntryBytes = positiveIntegerOrDefault(
    options.maxEntryBytes,
    defaultMaxEntryBytes
  );
  const maxTotalBytes = positiveIntegerOrDefault(
    options.maxTotalBytes,
    defaultMaxTotalBytes
  );
  let writeQueue = Promise.resolve();
  let lastUpdatedAtUnixMs = 0;

  const readIndex = async (): Promise<WorkbenchDockPreviewCacheIndex> => {
    try {
      const raw = await fs.readFile(indexPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WorkbenchDockPreviewCacheIndex>;
      if (parsed.version !== 1 || !parsed.entries) {
        return emptyIndex();
      }
      const entries: WorkbenchDockPreviewCacheIndex["entries"] = {};
      for (const [id, entry] of Object.entries(parsed.entries)) {
        if (!isValidIndexEntry(id, entry)) {
          continue;
        }
        entries[id] = entry;
      }
      return { entries, version: 1 };
    } catch {
      return emptyIndex();
    }
  };

  const writeIndex = (index: WorkbenchDockPreviewCacheIndex): Promise<void> =>
    atomicWriteFile(indexPath, JSON.stringify(index), "utf8");

  const writeNow = async (
    input: WorkbenchDockPreviewWriteInput
  ): Promise<boolean> => {
    if (!isValidDockPreviewCacheKey(input.key)) {
      return false;
    }
    const image = parseDockPreviewDataUrl(input.dataUrl, maxEntryBytes);
    if (!image) {
      return false;
    }

    await fs.mkdir(directory, { recursive: true });
    const id = dockPreviewCacheKeyHash(input.key);
    const nextFile = `${id}${extensionForMimeType(image.mimeType)}`;
    const nextPath = path.join(directory, nextFile);
    const index = await readIndex();
    const previous = index.entries[id];

    await atomicWriteFile(nextPath, image.bytes);
    index.entries[id] = {
      byteLength: image.bytes.byteLength,
      file: nextFile,
      mimeType: image.mimeType,
      updatedAtUnixMs: nextUpdatedAtUnixMs()
    };
    await pruneIndex({ directory, index, maxEntries, maxTotalBytes });
    await writeIndex(index);

    if (previous && previous.file !== nextFile) {
      await fs.rm(path.join(directory, previous.file), { force: true });
    }
    return true;
  };

  return {
    async read(key) {
      if (!isValidDockPreviewCacheKey(key)) {
        return null;
      }
      const index = await readIndex();
      const entry = index.entries[dockPreviewCacheKeyHash(key)];
      if (!entry || entry.byteLength > maxEntryBytes) {
        return null;
      }
      try {
        const bytes = await fs.readFile(path.join(directory, entry.file));
        if (
          bytes.byteLength === 0 ||
          bytes.byteLength > maxEntryBytes ||
          bytes.byteLength !== entry.byteLength
        ) {
          return null;
        }
        return `data:${entry.mimeType};base64,${bytes.toString("base64")}`;
      } catch {
        return null;
      }
    },
    write(input) {
      const result = writeQueue.then(
        () => writeNow(input),
        () => writeNow(input)
      );
      writeQueue = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    }
  };

  function nextUpdatedAtUnixMs(): number {
    lastUpdatedAtUnixMs = Math.max(Date.now(), lastUpdatedAtUnixMs + 1);
    return lastUpdatedAtUnixMs;
  }
}

function emptyIndex(): WorkbenchDockPreviewCacheIndex {
  return {
    entries: {},
    version: 1
  };
}

function parseDockPreviewDataUrl(
  dataUrl: string,
  maxEntryBytes: number
): { bytes: Buffer; mimeType: WorkbenchDockPreviewMimeType } | null {
  if (
    typeof dataUrl !== "string" ||
    dataUrl.length > maxDataUrlLength(maxEntryBytes)
  ) {
    return null;
  }
  const match =
    /^data:(image\/(?:jpeg|png|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/u.exec(
      dataUrl
    );
  if (!match) {
    return null;
  }
  const mimeType = match[1] as WorkbenchDockPreviewMimeType | undefined;
  const encodedBytes = match[2];
  if (!mimeType || !encodedBytes) {
    return null;
  }
  const bytes = Buffer.from(encodedBytes, "base64");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maxEntryBytes ||
    bytes.toString("base64") !== encodedBytes
  ) {
    return null;
  }
  return {
    bytes,
    mimeType
  };
}

function maxDataUrlLength(maxEntryBytes: number): number {
  return "data:image/jpeg;base64,".length + Math.ceil(maxEntryBytes / 3) * 4;
}

function isValidDockPreviewCacheKey(
  key: unknown
): key is WorkbenchDockPreviewCacheKey {
  if (!key || typeof key !== "object") {
    return false;
  }
  const typed = key as Partial<WorkbenchDockPreviewCacheKey>;
  const parts = [
    typed.instanceId,
    typed.instanceKey ?? "",
    typed.nodeId,
    typed.revision ?? "",
    typed.typeId,
    typed.workspaceId
  ];
  if (
    !isValidRequiredCacheKeyPart(typed.instanceId) ||
    !isValidOptionalCacheKeyPart(typed.instanceKey) ||
    !isValidRequiredCacheKeyPart(typed.nodeId) ||
    !isValidOptionalCacheKeyPart(typed.revision) ||
    !isValidRequiredCacheKeyPart(typed.typeId) ||
    !isValidRequiredCacheKeyPart(typed.workspaceId)
  ) {
    return false;
  }
  return parts.join("").length <= maxCacheKeyTotalLength;
}

function isValidRequiredCacheKeyPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxCacheKeyPartLength
  );
}

function isValidOptionalCacheKeyPart(value: unknown): value is string | null {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.length <= maxCacheKeyPartLength)
  );
}

function dockPreviewCacheKeyHash(key: WorkbenchDockPreviewCacheKey): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        instanceId: key.instanceId,
        instanceKey: key.instanceKey ?? null,
        nodeId: key.nodeId,
        revision: key.revision ?? null,
        typeId: key.typeId,
        workspaceId: key.workspaceId
      })
    )
    .digest("hex");
}

async function pruneIndex(input: {
  directory: string;
  index: WorkbenchDockPreviewCacheIndex;
  maxEntries: number;
  maxTotalBytes: number;
}): Promise<void> {
  const entries = Object.entries(input.index.entries).sort(
    (left, right) => right[1].updatedAtUnixMs - left[1].updatedAtUnixMs
  );
  let totalBytes = 0;
  const retained = new Set<string>();

  for (const [id, entry] of entries) {
    const canRetain =
      retained.size < input.maxEntries &&
      totalBytes + entry.byteLength <= input.maxTotalBytes;
    if (!canRetain) {
      continue;
    }
    retained.add(id);
    totalBytes += entry.byteLength;
  }

  await Promise.all(
    entries
      .filter(([id]) => !retained.has(id))
      .map(([, entry]) =>
        fs.rm(path.join(input.directory, entry.file), { force: true })
      )
  );

  for (const [id] of entries) {
    if (!retained.has(id)) {
      delete input.index.entries[id];
    }
  }
}

function isValidIndexEntry(
  id: string,
  entry: unknown
): entry is WorkbenchDockPreviewCacheIndexEntry {
  if (!sha256Pattern.test(id) || !entry || typeof entry !== "object") {
    return false;
  }
  const typed = entry as Partial<WorkbenchDockPreviewCacheIndexEntry>;
  return (
    typeof typed.file === "string" &&
    typed.file === `${id}${extensionForMimeType(typed.mimeType ?? "")}` &&
    isWorkbenchDockPreviewMimeType(typed.mimeType) &&
    typeof typed.byteLength === "number" &&
    Number.isSafeInteger(typed.byteLength) &&
    typed.byteLength > 0 &&
    typeof typed.updatedAtUnixMs === "number" &&
    Number.isFinite(typed.updatedAtUnixMs)
  );
}

function isWorkbenchDockPreviewMimeType(
  value: unknown
): value is WorkbenchDockPreviewMimeType {
  return (
    value === "image/jpeg" || value === "image/png" || value === "image/webp"
  );
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
}

async function atomicWriteFile(
  destination: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding
): Promise<void> {
  const temporaryPath = `${destination}.tmp-${process.pid}-${++temporaryFileSequence}`;
  try {
    if (typeof data === "string") {
      await fs.writeFile(temporaryPath, data, encoding);
    } else {
      await fs.writeFile(temporaryPath, data);
    }
    await fs.rename(temporaryPath, destination);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function requireDirectory(directory: string): string {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("Dock preview cache directory must be non-empty");
  }
  return directory;
}

function positiveIntegerOrDefault(
  value: number | undefined,
  defaultValue: number
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Dock preview cache limits must be positive integers");
  }
  return value;
}
