import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const CATALOG_REVISION_RE = /sha256:[0-9a-f]{8,}/g;
const BUSINESS_CATALOG_ASSIGNMENT_RE =
  /businessEventCatalogRevision\s*=\s*"(sha256:[0-9a-f]+)"/;
const GO_CATALOG_ASSIGNMENT_RE =
  /BusinessEventCatalogRevision\s*=\s*"(sha256:[0-9a-f]+)"/;
const MISMATCH_LOG_RE =
  /Event stream catalog revision mismatch\.\s*Expected\s+(sha256:[0-9a-f]+),\s*received\s+(sha256:[0-9a-f]+)/;

/**
 * Extract a business-event catalog revision from source, bundle, or binary text.
 * Prefers explicit assignment forms, then falls back to the first sha256 token.
 */
export function extractCatalogRevision(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const assigned =
    text.match(BUSINESS_CATALOG_ASSIGNMENT_RE)?.[1] ??
    text.match(GO_CATALOG_ASSIGNMENT_RE)?.[1] ??
    null;
  if (assigned) return assigned;
  const matches = text.match(CATALOG_REVISION_RE);
  return matches?.[0] ?? null;
}

export function formatCatalogMismatchError(input) {
  const desktop = input.desktopRevision ?? "unknown";
  const daemon = input.daemonRevision ?? "unknown";
  const desktopSource = input.desktopSource ?? "desktop";
  const daemonSource = input.daemonSource ?? "tuttid";
  const guidance =
    input.guidance ??
    "Rebuild desktop (apps/desktop/out) and tuttids from the same commit, " +
      "or clear stale prepared Electron/out artifacts before recording.";
  return (
    `desktop/tuttid event stream catalog mismatch (fail-fast): ` +
    `${desktopSource}=${desktop}, ${daemonSource}=${daemon}. ` +
    guidance
  );
}

export async function readCatalogRevisionFromFile(path) {
  try {
    return extractCatalogRevision(await readFile(path, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readCatalogRevisionFromBinary(path) {
  try {
    const buffer = await readFile(path);
    // Binary may contain multiple sha256 tokens; prefer the business-event one
    // by scanning latin1 and matching assignment-like nearby text first.
    const latin1 = buffer.toString("latin1");
    const assigned = extractCatalogRevisionFromBinaryAssignment(latin1);
    if (assigned) return assigned;
    // Fall back: tuttidd embeds the revision as a naked string constant.
    const matches = latin1.match(CATALOG_REVISION_RE) ?? [];
    // Prefer 16-hex-nibble revisions used by generate-event-protocol.
    const short = matches.find((value) => /^sha256:[0-9a-f]{16}$/.test(value));
    return short ?? matches[0] ?? null;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function extractCatalogRevisionFromBinaryAssignment(text) {
  const marker = "BusinessEventCatalogRevision";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;

  const assignmentIndex = text.indexOf("=", markerIndex + marker.length);
  if (assignmentIndex < 0 || assignmentIndex - markerIndex > 128) {
    return null;
  }

  const quoteIndex = text.indexOf('"', assignmentIndex + 1);
  if (quoteIndex < 0 || quoteIndex - assignmentIndex > 128) {
    return null;
  }

  return text.slice(quoteIndex + 1).match(/^sha256:[0-9a-f]+/)?.[0] ?? null;
}

export async function readCatalogRevisionFromDesktopRendererOut(workspaceRoot) {
  const assetsDirectory = join(
    workspaceRoot,
    "apps",
    "desktop",
    "out",
    "renderer",
    "assets"
  );
  let entries = [];
  try {
    entries = await readdir(assetsDirectory);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  for (const name of entries) {
    if (!name.endsWith(".js")) continue;
    const revision = await readCatalogRevisionFromFile(
      join(assetsDirectory, name)
    );
    if (revision) return revision;
  }
  return null;
}

export async function readCatalogRevisionFromEventProtocolSource(
  workspaceRoot
) {
  return readCatalogRevisionFromFile(
    join(
      workspaceRoot,
      "packages",
      "events",
      "protocol",
      "src",
      "generated",
      "registry.ts"
    )
  );
}

/**
 * @param {'out' | 'source' | 'out-then-source' | 'source-then-out'} [prefer]
 */
export async function resolveDesktopEventStreamCatalogRevision(
  workspaceRoot,
  prefer = "out-then-source"
) {
  const readOut = async () => {
    const renderer =
      await readCatalogRevisionFromDesktopRendererOut(workspaceRoot);
    if (renderer) {
      return { revision: renderer, source: "desktop-out-renderer" };
    }
    const main = await readCatalogRevisionFromFile(
      join(workspaceRoot, "apps", "desktop", "out", "main", "index.js")
    );
    if (main) {
      return { revision: main, source: "desktop-out-main" };
    }
    return null;
  };
  const readSource = async () => {
    const protocol =
      await readCatalogRevisionFromEventProtocolSource(workspaceRoot);
    if (protocol) {
      return { revision: protocol, source: "event-protocol-source" };
    }
    return null;
  };

  if (prefer === "out") return readOut();
  if (prefer === "source") return readSource();
  if (prefer === "source-then-out") {
    return (await readSource()) ?? (await readOut());
  }
  return (await readOut()) ?? (await readSource());
}

export async function resolveDaemonEventStreamCatalogRevision(input) {
  const daemonPath = input.daemonPath?.trim?.() || input.daemonPath || "";
  if (daemonPath) {
    const fromBinary = await readCatalogRevisionFromBinary(daemonPath);
    if (fromBinary) {
      return { revision: fromBinary, source: "daemon-binary" };
    }
  }
  const fromGo = await readCatalogRevisionFromFile(
    join(
      input.workspaceRoot,
      "services",
      "tuttid",
      "api",
      "events",
      "generated",
      "protocol.gen.go"
    )
  );
  if (fromGo) {
    return { revision: fromGo, source: "tuttid-protocol-source" };
  }
  return null;
}

/**
 * Fail when desktop/tuttid catalogs diverge.
 * No-ops when either side cannot be resolved (e.g. cold pnpm-dev without out/).
 *
 * @param {{ daemonPath?: string, workspaceRoot: string, desktopPrefer?: string }} input
 */
export async function assertEventStreamCatalogAligned(input) {
  const desktopPrefer = input.desktopPrefer ?? "out-then-source";
  const desktop = await resolveDesktopEventStreamCatalogRevision(
    input.workspaceRoot,
    desktopPrefer
  );
  const daemon = await resolveDaemonEventStreamCatalogRevision({
    daemonPath: input.daemonPath,
    workspaceRoot: input.workspaceRoot
  });
  if (!desktop || !daemon) return { checked: false, desktop, daemon };
  if (desktop.revision !== daemon.revision) {
    throw new Error(
      formatCatalogMismatchError({
        daemonRevision: daemon.revision,
        daemonSource: daemon.source,
        desktopRevision: desktop.revision,
        desktopSource: desktop.source
      })
    );
  }
  return { checked: true, desktop, daemon };
}

/**
 * Align catalogs for a launch. Stale prepared `apps/desktop/out` automatically
 * falls back to pnpm-dev-desktop when event-protocol source matches tuttidd.
 *
 * Managed launches (must use a fixed Electron binary) cannot fall back — they
 * still fail fast so the operator rebuilds out/.
 */
export async function reconcileEventStreamCatalogForLaunch(input) {
  const preparedElectron = Boolean(input.preparedElectron);
  const managed = Boolean(input.managed);
  const daemon = await resolveDaemonEventStreamCatalogRevision({
    daemonPath: input.daemonPath,
    workspaceRoot: input.workspaceRoot
  });
  if (!daemon) {
    return {
      checked: false,
      fallbackToPnpmDev: false,
      daemon: null,
      desktop: null
    };
  }

  if (!preparedElectron) {
    // Vite/dev uses protocol source; ignore stale out/ so we do not false-fail.
    const result = await assertEventStreamCatalogAligned({
      daemonPath: input.daemonPath,
      desktopPrefer: "source-then-out",
      workspaceRoot: input.workspaceRoot
    });
    return { ...result, fallbackToPnpmDev: false };
  }

  const out = await resolveDesktopEventStreamCatalogRevision(
    input.workspaceRoot,
    "out"
  );
  if (out && out.revision === daemon.revision) {
    return {
      checked: true,
      desktop: out,
      daemon,
      fallbackToPnpmDev: false
    };
  }

  const source = await resolveDesktopEventStreamCatalogRevision(
    input.workspaceRoot,
    "source"
  );
  if (source && source.revision === daemon.revision) {
    if (managed) {
      throw new Error(
        formatCatalogMismatchError({
          daemonRevision: daemon.revision,
          daemonSource: daemon.source,
          desktopRevision: out?.revision ?? "missing",
          desktopSource: out?.source ?? "desktop-out",
          guidance:
            "Managed replay cannot auto-fall back to pnpm-dev-desktop. " +
            "Rebuild apps/desktop/out (or clear managed Electron env) so " +
            "renderer matches tuttidd."
        })
      );
    }
    return {
      checked: true,
      desktop: source,
      daemon,
      fallbackToPnpmDev: true,
      message:
        `stale prepared desktop out catalog ` +
        `(${out?.source ?? "desktop-out"}=${out?.revision ?? "missing"} vs ` +
        `${daemon.source}=${daemon.revision}); ` +
        `auto-falling back to pnpm-dev-desktop (event-protocol source matches)`
    };
  }

  throw new Error(
    formatCatalogMismatchError({
      daemonRevision: daemon.revision,
      daemonSource: daemon.source,
      desktopRevision: out?.revision ?? source?.revision ?? "unknown",
      desktopSource: out?.source ?? source?.source ?? "desktop",
      guidance:
        "Neither prepared out/ nor event-protocol source match tuttidd. " +
        "Run pnpm generate:event-protocol and rebuild desktop + tuttids " +
        "from the same commit."
    })
  );
}

export function clearPreparedElectronEnv(env = process.env) {
  delete env.TUTTI_AGENT_SESSION_REPLAY_ELECTRON_EXECUTABLE;
  delete env.TUTTI_AGENT_SESSION_REPLAY_ELECTRON_ENTRY;
}

/**
 * Check the live Desktop log once after CDP is ready. The source/artifact
 * reconciliation above is the authoritative preflight; this snapshot only
 * turns an already-emitted handshake failure into a useful error. Polling here
 * has no success signal and used to delay every healthy replay by 8 seconds.
 */
export async function assertDesktopLogHasNoCatalogMismatch(logPath) {
  let lastText;
  try {
    lastText = await readFile(logPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { checked: false };
    throw error;
  }

  const match = lastText.match(MISMATCH_LOG_RE);
  if (match) {
    throw new Error(
      formatCatalogMismatchError({
        daemonRevision: match[2],
        daemonSource: "tuttid-ready-frame",
        desktopRevision: match[1],
        desktopSource: "desktop-event-stream-client"
      })
    );
  }
  if (
    lastText.includes("catalog revision mismatch") ||
    lastText.includes("event_stream.connect_failed")
  ) {
    throw new Error(
      formatCatalogMismatchError({
        daemonRevision: "see desktop.log",
        daemonSource: "tuttid",
        desktopRevision: "see desktop.log",
        desktopSource: "desktop"
      })
    );
  }
  return { checked: true };
}
