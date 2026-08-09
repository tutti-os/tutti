import { open, stat, watch } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { recordValue } from "./normalizer.ts";
import { stringValue } from "./runtimeValues.ts";

type GoalStatusObserver = (value: Record<string, unknown>) => void;

const CLAUDE_PROJECT_ID_MAX_LENGTH = 200;

/**
 * Mirrors the local project-key algorithm in the pinned Claude Agent SDK.
 * The SDK does not expose the transcript path on system/init, only its cwd and
 * session_id, so consumers of the local transcript must resolve the same key.
 */
export function claudeGoalTranscriptPath(options: {
  sessionId: string;
  cwd: string;
  env: Record<string, string | undefined>;
}): string {
  const configDir =
    options.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const resolvedCwd = resolveClaudeProjectCwd(options.cwd);
  const projectId = claudeProjectId(resolvedCwd);
  return join(configDir, "projects", projectId, `${options.sessionId}.jsonl`);
}

export function claudeProjectId(resolvedCwd: string): string {
  const sanitized = resolvedCwd.replace(/[^a-zA-Z0-9]/g, "-");
  return sanitized.length <= CLAUDE_PROJECT_ID_MAX_LENGTH
    ? sanitized
    : `${sanitized.slice(0, CLAUDE_PROJECT_ID_MAX_LENGTH)}-${claudeProjectHash(
        resolvedCwd
      )}`;
}

function resolveClaudeProjectCwd(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function claudeProjectHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Reads only transcript rows appended after this sidecar starts observing.
 *
 * Claude's local SDK stream omits goal_status attachments. SessionStart can
 * supply the exact path; system/init and resume can resolve it from the pinned
 * SDK's local project key. This reader recovers only newly appended evidence.
 */
export class ClaudeGoalTranscript {
  private readonly observe: GoalStatusObserver;
  private path = "";
  private offset = 0;
  private operation: Promise<void> = Promise.resolve();
  private watcherAbort: AbortController | undefined;
  private watcherTask: Promise<void> | undefined;

  constructor(observe: GoalStatusObserver) {
    this.observe = observe;
  }

  start(path: string): Promise<void> {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return Promise.resolve();
    }
    return this.serialize(async () => {
      if (normalizedPath === this.path) {
        return;
      }
      await this.stopWatcher();
      this.path = normalizedPath;
      this.offset = await stat(normalizedPath).then(
        (snapshot) => snapshot.size,
        () => 0
      );
      this.startWatcher(normalizedPath);
      // Close the stat-to-watch registration gap without replaying history.
      void this.drain();
    });
  }

  async close(): Promise<void> {
    await this.drain();
    await this.serialize(async () => {
      await this.stopWatcher();
      this.path = "";
      this.offset = 0;
    });
  }

  drain(): Promise<void> {
    return this.serialize(async () => {
      if (!this.path) {
        return;
      }
      let file;
      try {
        file = await open(this.path, "r");
      } catch {
        return;
      }
      try {
        const snapshot = await file.stat();
        if (snapshot.size < this.offset) {
          // Never replay historical rows after a truncation or replacement.
          this.offset = snapshot.size;
          return;
        }
        const unreadBytes = snapshot.size - this.offset;
        if (unreadBytes <= 0) {
          return;
        }
        const buffer = Buffer.allocUnsafe(unreadBytes);
        let bytesRead = 0;
        while (bytesRead < unreadBytes) {
          const read = await file.read(
            buffer,
            bytesRead,
            unreadBytes - bytesRead,
            this.offset + bytesRead
          );
          if (read.bytesRead === 0) {
            break;
          }
          bytesRead += read.bytesRead;
        }
        const complete = buffer.subarray(0, bytesRead);
        const lastNewline = complete.lastIndexOf(0x0a);
        if (lastNewline < 0) {
          return;
        }
        this.offset += lastNewline + 1;
        for (const rawLine of complete
          .subarray(0, lastNewline)
          .toString("utf8")
          .split("\n")) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (!line.trim()) {
            continue;
          }
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          const message = recordValue(value);
          const attachment = recordValue(message?.attachment);
          if (
            message &&
            stringValue(message.type) === "attachment" &&
            stringValue(attachment?.type) === "goal_status"
          ) {
            this.observe(message);
          }
        }
      } catch {
        // Transcript observation is supporting evidence. It must never fail
        // the provider Turn when the file is temporarily unavailable.
      } finally {
        await file.close().catch(() => undefined);
      }
    });
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const run = this.operation.then(operation, operation);
    this.operation = run.catch(() => undefined);
    return run;
  }

  private startWatcher(path: string): void {
    const abort = new AbortController();
    this.watcherAbort = abort;
    this.watcherTask = (async () => {
      try {
        // system/init can arrive just before Claude creates the transcript.
        // Observe its existing project directory so both file creation and
        // subsequent appends wake the incremental reader.
        for await (const _event of watch(dirname(path), {
          persistent: false,
          signal: abort.signal
        })) {
          if (abort.signal.aborted || path !== this.path) {
            return;
          }
          void this.drain();
        }
      } catch {
        // A root result still performs an explicit drain. File watching is
        // needed only for transcript rows flushed after that SDK boundary.
      }
    })();
  }

  private async stopWatcher(): Promise<void> {
    const abort = this.watcherAbort;
    const task = this.watcherTask;
    this.watcherAbort = undefined;
    this.watcherTask = undefined;
    abort?.abort();
    await task?.catch(() => undefined);
  }
}
