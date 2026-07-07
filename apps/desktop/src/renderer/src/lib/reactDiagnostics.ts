type DiagnosticConsole = Pick<
  Console,
  "error" | "groupCollapsed" | "groupEnd" | "info" | "warn"
>;

type ReactErrorInfo = {
  componentStack?: string;
};

type ReactErrorKind = "caught" | "recoverable" | "uncaught";

type ReactRootErrorLoggerOptions = {
  captureOwnerStack?: () => string | null;
  console?: DiagnosticConsole;
  logRendererDiagnostic?: RendererDiagnosticSink;
};

type RenderCommit = {
  actualDuration: number;
  baseDuration: number;
  commitTime: number;
  id: string;
  phase: "mount" | "nested-update" | "update";
  startTime: number;
};

type RenderStormTrackerOptions = {
  captureStack?: () => string;
  console?: DiagnosticConsole;
  cooldownMs?: number;
  logRendererDiagnostic?: RendererDiagnosticSink;
  threshold?: number;
  windowMs?: number;
};

type BrowserCrashLoggerOptions = {
  console?: DiagnosticConsole;
  logRendererDiagnostic?: RendererDiagnosticSink;
  window?: Window;
};

type RendererDiagnosticInput = {
  details?: Record<string, unknown>;
  event: string;
  level?: "debug" | "error" | "info" | "warn";
  source: string;
  workspaceId?: string | null;
};

type RendererDiagnosticSink = (input: RendererDiagnosticInput) => void;

const DEFAULT_RENDER_STORM_THRESHOLD = 30;
const DEFAULT_RENDER_STORM_WINDOW_MS = 1000;
const DEFAULT_RENDER_STORM_COOLDOWN_MS = 5000;

export function createReactRootErrorLogger(
  options: ReactRootErrorLoggerOptions = {}
): (kind: ReactErrorKind, error: unknown, errorInfo?: ReactErrorInfo) => void {
  const diagnosticConsole = options.console ?? console;

  return (kind, error, errorInfo) => {
    const componentStack = errorInfo?.componentStack?.trim() || "(unavailable)";
    const ownerStack = options.captureOwnerStack?.()?.trim() || "(unavailable)";
    diagnosticConsole.groupCollapsed(
      `[tutti:react:${kind}]`,
      formatErrorSummary(error)
    );
    diagnosticConsole.error(error);
    diagnosticConsole.info("componentStack", componentStack);
    diagnosticConsole.info("ownerStack", ownerStack);
    diagnosticConsole.groupEnd();
    sendRendererDiagnostic(options.logRendererDiagnostic, {
      details: {
        ...errorDiagnosticDetails(error),
        componentStack,
        ownerStack
      },
      event: `react.${kind}`,
      level: kind === "recoverable" ? "warn" : "error",
      source: "react-diagnostics"
    });
  };
}

export function createRenderStormTracker(
  options: RenderStormTrackerOptions = {}
): { record: (commit: RenderCommit) => void } {
  const diagnosticConsole = options.console ?? console;
  const threshold = options.threshold ?? DEFAULT_RENDER_STORM_THRESHOLD;
  const windowMs = options.windowMs ?? DEFAULT_RENDER_STORM_WINDOW_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_RENDER_STORM_COOLDOWN_MS;
  const commitsById = new Map<string, RenderCommit[]>();
  const lastLoggedById = new Map<string, number>();

  return {
    record(commit) {
      const windowStart = commit.commitTime - windowMs;
      const commits = [...(commitsById.get(commit.id) ?? []), commit].filter(
        (candidate) => candidate.commitTime >= windowStart
      );
      commitsById.set(commit.id, commits);

      if (commits.length < threshold) {
        return;
      }

      const lastLoggedAt = lastLoggedById.get(commit.id) ?? -Infinity;
      if (commit.commitTime - lastLoggedAt < cooldownMs) {
        return;
      }

      const stack = options.captureStack?.() ?? new Error("render storm").stack;
      const recentCommits = commits.map(summarizeRenderCommit);
      const latestCommit = summarizeRenderCommit(commit);
      lastLoggedById.set(commit.id, commit.commitTime);
      diagnosticConsole.groupCollapsed(
        `[tutti:react:render storm] ${commit.id}`,
        `${commits.length} commits in ${windowMs}ms`
      );
      diagnosticConsole.warn("React render storm detected", latestCommit);
      diagnosticConsole.info("recent commits", recentCommits);
      diagnosticConsole.info("stack", stack);
      diagnosticConsole.groupEnd();
      sendRendererDiagnostic(options.logRendererDiagnostic, {
        details: {
          commitCount: commits.length,
          latestCommit,
          recentCommits,
          stack,
          windowMs
        },
        event: "react.render_storm",
        level: "warn",
        source: "react-diagnostics"
      });
    }
  };
}

export function installBrowserCrashLogging(
  options: BrowserCrashLoggerOptions = {}
): () => void {
  const targetWindow = options.window ?? globalThis.window;
  const diagnosticConsole = options.console ?? console;
  const handleError = (event: ErrorEvent): void => {
    diagnosticConsole.groupCollapsed(
      "[tutti:runtime:error]",
      event.message || "(no message)"
    );
    diagnosticConsole.error(event.error ?? event.message);
    diagnosticConsole.info("source", {
      colno: event.colno,
      filename: event.filename,
      lineno: event.lineno
    });
    diagnosticConsole.info(
      "stack",
      event.error instanceof Error ? event.error.stack : "(unavailable)"
    );
    diagnosticConsole.groupEnd();
    sendRendererDiagnostic(options.logRendererDiagnostic, {
      details: {
        ...errorDiagnosticDetails(event.error ?? event.message),
        column: finiteNumber(event.colno),
        filename: trimmedString(event.filename),
        line: finiteNumber(event.lineno)
      },
      event: "runtime.error",
      level: "error",
      source: "react-diagnostics"
    });
  };
  const handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    diagnosticConsole.groupCollapsed(
      "[tutti:runtime:unhandledrejection]",
      formatErrorSummary(event.reason)
    );
    diagnosticConsole.error(event.reason);
    diagnosticConsole.info(
      "stack",
      event.reason instanceof Error ? event.reason.stack : "(unavailable)"
    );
    diagnosticConsole.groupEnd();
    sendRendererDiagnostic(options.logRendererDiagnostic, {
      details: errorDiagnosticDetails(event.reason),
      event: "runtime.unhandled_rejection",
      level: "error",
      source: "react-diagnostics"
    });
  };

  targetWindow.addEventListener("error", handleError);
  targetWindow.addEventListener("unhandledrejection", handleUnhandledRejection);

  return () => {
    targetWindow.removeEventListener("error", handleError);
    targetWindow.removeEventListener(
      "unhandledrejection",
      handleUnhandledRejection
    );
  };
}

function formatErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function errorDiagnosticDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: limitDiagnosticText(error.stack)
    };
  }
  return {
    message: limitDiagnosticText(formatErrorSummary(error)),
    name: typeof error
  };
}

function limitDiagnosticText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const maxLength = 8_000;
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength)}...`
    : trimmed;
}

function sendRendererDiagnostic(
  logRendererDiagnostic: RendererDiagnosticSink | undefined,
  input: RendererDiagnosticInput
): void {
  try {
    logRendererDiagnostic?.(input);
  } catch {
    // Diagnostics must never become the reason the renderer fails.
  }
}

function summarizeRenderCommit(commit: RenderCommit): Record<string, unknown> {
  return {
    actualDuration: Number(commit.actualDuration.toFixed(2)),
    baseDuration: Number(commit.baseDuration.toFixed(2)),
    commitTime: Number(commit.commitTime.toFixed(2)),
    phase: commit.phase,
    startTime: Number(commit.startTime.toFixed(2))
  };
}

function finiteNumber(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function trimmedString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}
