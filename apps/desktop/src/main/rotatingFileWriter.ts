import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFile
} from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

const logDayFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export interface RotatingFileWriterOptions {
  maxSizeBytes: number;
  maxBackups: number;
  maxAgeDays: number;
  maxTotalBytes: number;
  now?: () => Date;
}

interface RotatedLogFile {
  path: string;
  day: string;
  idx: number;
  size: number;
  mtimeMs: number;
}

export class RotatingFileWriter {
  private readonly activePath: string;
  private readonly dir: string;
  private readonly rotatedPrefix: string;
  private readonly rotatedSuffix: string;
  private readonly maxSizeBytes: number;
  private readonly maxBackups: number;
  private readonly maxAgeDays: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => Date;

  private fd: number | null = null;
  private currentDay = "";
  private currentSize = 0;

  private constructor(path: string, options: RotatingFileWriterOptions) {
    this.activePath = path;
    this.dir = dirname(path);
    const suffix = extname(path);
    this.rotatedSuffix = suffix;
    this.rotatedPrefix = suffix ? basename(path, suffix) : basename(path);
    this.maxSizeBytes = options.maxSizeBytes;
    this.maxBackups = options.maxBackups;
    this.maxAgeDays = options.maxAgeDays;
    this.maxTotalBytes = options.maxTotalBytes;
    this.now = options.now ?? (() => new Date());
  }

  static async create(
    path: string,
    options: RotatingFileWriterOptions
  ): Promise<RotatingFileWriter> {
    const writer = new RotatingFileWriter(resolve(path), options);
    await writer.openActive();
    writer.cleanup(writer.dayString(writer.now()));
    return writer;
  }

  path(): string {
    return this.activePath;
  }

  async write(content: string): Promise<void> {
    const today = this.dayString(this.now());
    await this.ensureReady(today, Buffer.byteLength(content));
    if (this.fd === null) {
      throw new Error("log writer is not open");
    }

    const fd = this.fd;
    await new Promise<void>((resolve, reject) => {
      writeFile(fd, content, { encoding: "utf8", flag: "a" }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.currentSize += Buffer.byteLength(content);
  }

  close(): Promise<void> {
    if (this.fd === null) {
      return Promise.resolve();
    }

    closeSync(this.fd);
    this.fd = null;
    this.currentDay = "";
    this.currentSize = 0;
    return Promise.resolve();
  }

  private async ensureReady(today: string, writeLen: number): Promise<void> {
    if (this.fd === null) {
      await this.openActive();
    }

    if (this.currentSize > 0 && this.currentDay && this.currentDay !== today) {
      await this.rotateActive(this.currentDay);
    }

    if (
      this.maxSizeBytes > 0 &&
      this.currentSize > 0 &&
      this.currentSize + writeLen > this.maxSizeBytes
    ) {
      await this.rotateActive(today);
    }
  }

  private async rotateActive(day: string): Promise<void> {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }

    if (this.currentSize > 0) {
      const rotatedPath = this.nextRotatedPath(day);
      try {
        renameSync(this.activePath, rotatedPath);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }

    await this.openActive();
    this.cleanup(day);
  }

  private async openActive(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    this.fd = openSync(this.activePath, "a", 0o644);
    const info = await stat(this.activePath);
    this.currentSize = info.size;
    this.currentDay =
      this.currentSize === 0
        ? this.dayString(this.now())
        : this.dayString(info.mtime);
  }

  private nextRotatedPath(day: string): string {
    const used = new Set<number>();
    for (const entry of this.safeReadDir(this.dir)) {
      const parsed = this.parseRotatedName(entry);
      if (parsed && parsed.day === day) {
        used.add(parsed.idx);
      }
    }

    for (let idx = 0; ; idx += 1) {
      if (!used.has(idx)) {
        return join(this.dir, this.rotatedFileName(day, idx));
      }
    }
  }

  private cleanup(today: string): void {
    const files = this.collectCleanupCandidates();
    if (files.length === 0) {
      return;
    }

    const removePaths = new Set<string>();
    if (this.maxAgeDays > 0) {
      const cutoff = this.cutoffDay(this.now(), this.maxAgeDays);
      for (const file of files) {
        if (file.day !== today && file.day < cutoff) {
          removePaths.add(file.path);
        }
      }
    }

    if (this.maxBackups >= 0) {
      const remaining = files.filter((file) => !removePaths.has(file.path));
      remaining.sort((left, right) => {
        if (left.day !== right.day) {
          return left.day > right.day ? -1 : 1;
        }
        return right.idx - left.idx;
      });
      for (const file of remaining.slice(this.maxBackups)) {
        removePaths.add(file.path);
      }
    }

    for (const path of removePaths) {
      rmSync(path, { force: true });
    }

    this.pruneDirectoryBudget();
  }

  private collectCleanupCandidates(): RotatedLogFile[] {
    const files: RotatedLogFile[] = [];
    for (const entry of this.safeReadDir(this.dir)) {
      const parsed = this.parseRotatedName(entry);
      if (!parsed) {
        continue;
      }

      try {
        const info = statSync(join(this.dir, entry));
        files.push({
          path: join(this.dir, entry),
          day: parsed.day,
          idx: parsed.idx,
          size: info.size,
          mtimeMs: info.mtimeMs
        });
      } catch {
        continue;
      }
    }
    return files;
  }

  private pruneDirectoryBudget(): void {
    if (this.maxTotalBytes <= 0) {
      return;
    }

    const files = this.safeReadDir(this.dir)
      .filter((entry) => isManagedLogFileName(entry))
      .flatMap((entry) => {
        try {
          const path = join(this.dir, entry);
          const info = statSync(path);
          return [
            {
              path,
              size: info.size,
              mtimeMs: info.mtimeMs,
              rotatable: isDateIndexedLogFileName(entry)
            }
          ];
        } catch {
          return [];
        }
      });

    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= this.maxTotalBytes) {
      return;
    }

    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of files) {
      if (!file.rotatable) {
        continue;
      }
      rmSync(file.path, { force: true });
      total -= file.size;
      if (total <= this.maxTotalBytes) {
        return;
      }
    }
  }

  private rotatedFileName(day: string, idx: number): string {
    if (idx <= 0) {
      return `${this.rotatedPrefix}.${day}${this.rotatedSuffix}`;
    }
    return `${this.rotatedPrefix}.${day}.${idx}${this.rotatedSuffix}`;
  }

  private parseRotatedName(name: string): { day: string; idx: number } | null {
    if (
      !name.startsWith(`${this.rotatedPrefix}.`) ||
      !name.endsWith(this.rotatedSuffix)
    ) {
      return null;
    }

    const trimmed = name.slice(
      this.rotatedPrefix.length + 1,
      name.length - this.rotatedSuffix.length
    );
    const parts = trimmed.split(".");
    if (parts.length === 0 || parts.length > 2) {
      return null;
    }

    const day = parts[0];
    if (!day) {
      return null;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return null;
    }

    if (parts.length === 1) {
      return { day, idx: 0 };
    }

    const idxPart = parts[1];
    if (!idxPart) {
      return null;
    }

    const idx = Number.parseInt(idxPart, 10);
    if (!Number.isInteger(idx) || idx < 1) {
      return null;
    }
    return { day, idx };
  }

  private isDateIndexedLogFileName(name: string): boolean {
    return this.parseRotatedName(name) !== null;
  }

  private cutoffDay(now: Date, maxAgeDays: number): string {
    const cutoff = new Date(now.getTime());
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    return this.dayString(cutoff);
  }

  private dayString(date: Date): string {
    return logDayFormatter.format(date);
  }

  private safeReadDir(path: string): string[] {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  }
}

function isManagedLogFileName(name: string): boolean {
  return name.endsWith(".log");
}

function isDateIndexedLogFileName(name: string): boolean {
  const base = name.slice(0, -".log".length);
  const lastDot = base.lastIndexOf(".");
  if (lastDot < 0) {
    return false;
  }

  const maybeDate = base.slice(lastDot + 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(maybeDate)) {
    return true;
  }

  const secondLastDot = base.lastIndexOf(".", lastDot - 1);
  if (secondLastDot < 0) {
    return false;
  }

  const indexedDate = base.slice(secondLastDot + 1, lastDot);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(indexedDate)) {
    return false;
  }

  return /^\d+$/.test(base.slice(lastDot + 1));
}
