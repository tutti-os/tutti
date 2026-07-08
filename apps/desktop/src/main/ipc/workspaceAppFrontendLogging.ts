import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TuttiExternalLogInput } from "@tutti-os/workspace-external-core/contracts";
import type { DesktopRuntimeLogLevel } from "../../shared/contracts/ipc";
import { resolveWorkspaceAppFolderPath } from "../host/workspaceAppFolderPaths.ts";

export interface WorkspaceAppFrontendLogContext {
  appID: string;
  workspaceID: string;
}

export interface WorkspaceAppFrontendLogRecord extends TuttiExternalLogInput {
  webSource?: string;
}

const workspaceAppFrontendLogRateLimitPerSecond = 50;

export function resolveWorkspaceAppWebLogPath(
  stateRootDir: string,
  context: WorkspaceAppFrontendLogContext
): string {
  return join(
    resolveWorkspaceAppFolderPath(stateRootDir, {
      appId: context.appID,
      folderKind: "logs",
      workspaceId: context.workspaceID
    }),
    "web.log"
  );
}

export function formatWorkspaceAppWebLogLine(
  input: WorkspaceAppFrontendLogRecord,
  context: WorkspaceAppFrontendLogContext,
  sessionID: string
): string {
  const level = input.level ?? "info";
  const fields = [
    `time=${new Date().toISOString()}`,
    `level=${level}`,
    `component=${JSON.stringify("tutti-workspace-app-web")}`,
    `pid=${process.pid}`,
    `session_id=${JSON.stringify(sessionID)}`,
    `workspace_id=${JSON.stringify(context.workspaceID)}`,
    `app_id=${JSON.stringify(context.appID)}`,
    `msg=${JSON.stringify("web diagnostic")}`,
    `web_event=${JSON.stringify(input.event)}`,
    `web_details=${JSON.stringify(input.details ?? {})}`
  ];

  if (input.webSource) {
    fields.push(`web_source=${JSON.stringify(input.webSource)}`);
  }

  return `${fields.join(" ")}\n`;
}

export class WorkspaceAppGuestLogRateLimiter {
  private readonly timestampsByGuest = new Map<number, number[]>();

  allow(
    guestWebContentsId: number,
    limit = workspaceAppFrontendLogRateLimitPerSecond,
    windowMs = 1_000
  ): boolean {
    const now = Date.now();
    const recent = (
      this.timestampsByGuest.get(guestWebContentsId) ?? []
    ).filter((timestamp) => now - timestamp < windowMs);
    if (recent.length >= limit) {
      this.timestampsByGuest.set(guestWebContentsId, recent);
      return false;
    }

    recent.push(now);
    this.timestampsByGuest.set(guestWebContentsId, recent);
    return true;
  }

  forget(guestWebContentsId: number): void {
    this.timestampsByGuest.delete(guestWebContentsId);
  }
}

export class WorkspaceAppFrontendLogWriter {
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private readonly stateRootDir: string;
  private readonly sessionID: string;
  private readonly rateLimiter: WorkspaceAppGuestLogRateLimiter;

  constructor(
    stateRootDir: string,
    sessionID: string,
    rateLimiter: WorkspaceAppGuestLogRateLimiter
  ) {
    this.stateRootDir = stateRootDir;
    this.sessionID = sessionID;
    this.rateLimiter = rateLimiter;
  }

  write(
    guestWebContentsId: number,
    context: WorkspaceAppFrontendLogContext,
    input: WorkspaceAppFrontendLogRecord
  ): void {
    if (!this.rateLimiter.allow(guestWebContentsId)) {
      return;
    }

    const path = resolveWorkspaceAppWebLogPath(this.stateRootDir, context);
    const line = formatWorkspaceAppWebLogLine(input, context, this.sessionID);
    const pending = (this.pendingWrites.get(path) ?? Promise.resolve())
      .then(() => appendWorkspaceAppWebLogLine(path, line))
      .catch(() => undefined);
    this.pendingWrites.set(path, pending);
  }
}

function resolveWorkspaceAppFrontendLogLevel(
  event: string
): DesktopRuntimeLogLevel {
  return event.includes("failed") ? "warn" : "info";
}

export function normalizeWorkspaceAppDiagnosticLogRecord(
  payload: Record<string, unknown>
): WorkspaceAppFrontendLogRecord | null {
  const event = typeof payload.event === "string" ? payload.event.trim() : "";
  if (!event) {
    return null;
  }

  const details = isRecord(payload.details) ? payload.details : undefined;
  return {
    event,
    level: resolveWorkspaceAppFrontendLogLevel(event),
    ...(details ? { details } : {}),
    webSource: "preload"
  };
}

async function appendWorkspaceAppWebLogLine(
  path: string,
  line: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, { encoding: "utf8", flag: "a" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
