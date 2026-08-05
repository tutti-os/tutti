import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertDesktopLogHasNoCatalogMismatch,
  assertEventStreamCatalogAligned,
  clearPreparedElectronEnv,
  extractCatalogRevision,
  formatCatalogMismatchError,
  readCatalogRevisionFromBinary,
  readCatalogRevisionFromDesktopRendererOut,
  readCatalogRevisionFromFile,
  reconcileEventStreamCatalogForLaunch
} from "./event-stream-catalog.mjs";

test("extractCatalogRevision prefers businessEventCatalogRevision assignment", () => {
  const text = `
    const other = "sha256:deadbeefdeadbeef";
    const businessEventCatalogRevision = "sha256:0413e48c4012324e";
  `;
  assert.equal(extractCatalogRevision(text), "sha256:0413e48c4012324e");
});

test("extractCatalogRevision reads Go BusinessEventCatalogRevision", () => {
  const text = `\tBusinessEventCatalogRevision = "sha256:0413e48c4012324e"\n`;
  assert.equal(extractCatalogRevision(text), "sha256:0413e48c4012324e");
});

test("assertEventStreamCatalogAligned fails when renderer out and daemon diverge", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-align-"));
  const assets = join(root, "apps", "desktop", "out", "renderer", "assets");
  const daemonDir = join(root, "daemon");
  await mkdir(assets, { recursive: true });
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    join(assets, "browserNodeWebviewContext-test.js"),
    `const businessEventCatalogRevision = "sha256:2e36dcc0d1c65637";\n`
  );
  const daemonPath = join(daemonDir, "tuttid");
  await writeFile(
    daemonPath,
    Buffer.from(`xxBusinessEventCatalogRevision="sha256:0413e48c4012324e"yy`)
  );

  await assert.rejects(
    () =>
      assertEventStreamCatalogAligned({
        daemonPath,
        workspaceRoot: root
      }),
    /event stream catalog mismatch \(fail-fast\)/
  );
});

test("assertEventStreamCatalogAligned passes when revisions match", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-align-ok-"));
  const assets = join(root, "apps", "desktop", "out", "renderer", "assets");
  const daemonDir = join(root, "daemon");
  await mkdir(assets, { recursive: true });
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    join(assets, "browserNodeWebviewContext-test.js"),
    `const businessEventCatalogRevision = "sha256:0413e48c4012324e";\n`
  );
  const daemonPath = join(daemonDir, "tuttid");
  await writeFile(
    daemonPath,
    Buffer.from(`BusinessEventCatalogRevision="sha256:0413e48c4012324e"`)
  );
  const result = await assertEventStreamCatalogAligned({
    daemonPath,
    workspaceRoot: root
  });
  assert.equal(result.checked, true);
  assert.equal(result.desktop.revision, "sha256:0413e48c4012324e");
  assert.equal(result.daemon.revision, "sha256:0413e48c4012324e");
});

test("reconcile falls back to pnpm-dev when out is stale but source matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-fallback-"));
  const assets = join(root, "apps", "desktop", "out", "renderer", "assets");
  const protocolDir = join(
    root,
    "packages",
    "events",
    "protocol",
    "src",
    "generated"
  );
  const daemonDir = join(root, "daemon");
  await mkdir(assets, { recursive: true });
  await mkdir(protocolDir, { recursive: true });
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    join(assets, "browserNodeWebviewContext-test.js"),
    `const businessEventCatalogRevision = "sha256:2e36dcc0d1c65637";\n`
  );
  await writeFile(
    join(protocolDir, "registry.ts"),
    `export const businessEventCatalogRevision = "sha256:0413e48c4012324e";\n`
  );
  const daemonPath = join(daemonDir, "tuttid");
  await writeFile(
    daemonPath,
    Buffer.from(`BusinessEventCatalogRevision="sha256:0413e48c4012324e"`)
  );

  const result = await reconcileEventStreamCatalogForLaunch({
    daemonPath,
    preparedElectron: true,
    workspaceRoot: root
  });
  assert.equal(result.fallbackToPnpmDev, true);
  assert.equal(result.desktop.revision, "sha256:0413e48c4012324e");
  assert.match(result.message, /auto-falling back to pnpm-dev-desktop/);
});

test("reconcile does not fall back for managed launches", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-managed-"));
  const assets = join(root, "apps", "desktop", "out", "renderer", "assets");
  const protocolDir = join(
    root,
    "packages",
    "events",
    "protocol",
    "src",
    "generated"
  );
  const daemonDir = join(root, "daemon");
  await mkdir(assets, { recursive: true });
  await mkdir(protocolDir, { recursive: true });
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    join(assets, "browserNodeWebviewContext-test.js"),
    `const businessEventCatalogRevision = "sha256:2e36dcc0d1c65637";\n`
  );
  await writeFile(
    join(protocolDir, "registry.ts"),
    `export const businessEventCatalogRevision = "sha256:0413e48c4012324e";\n`
  );
  const daemonPath = join(daemonDir, "tuttid");
  await writeFile(
    daemonPath,
    Buffer.from(`BusinessEventCatalogRevision="sha256:0413e48c4012324e"`)
  );

  await assert.rejects(
    () =>
      reconcileEventStreamCatalogForLaunch({
        daemonPath,
        managed: true,
        preparedElectron: true,
        workspaceRoot: root
      }),
    /Managed replay cannot auto-fall back/
  );
});

test("clearPreparedElectronEnv removes launch env", () => {
  const env = {
    TUTTI_AGENT_SESSION_REPLAY_ELECTRON_EXECUTABLE: "/bin/Electron",
    TUTTI_AGENT_SESSION_REPLAY_ELECTRON_ENTRY: "/apps/desktop",
    KEEP: "1"
  };
  clearPreparedElectronEnv(env);
  assert.equal(env.TUTTI_AGENT_SESSION_REPLAY_ELECTRON_EXECUTABLE, undefined);
  assert.equal(env.TUTTI_AGENT_SESSION_REPLAY_ELECTRON_ENTRY, undefined);
  assert.equal(env.KEEP, "1");
});

test("assertDesktopLogHasNoCatalogMismatch fails fast on handshake error", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-log-"));
  const logPath = join(root, "desktop.log");
  await writeFile(
    logPath,
    `time=... msg="terminal diagnostic" details={"error":"Event stream catalog revision mismatch. Expected sha256:2e36dcc0d1c65637, received sha256:0413e48c4012324e."}\n`
  );
  await assert.rejects(
    () => assertDesktopLogHasNoCatalogMismatch(logPath),
    /fail-fast/
  );
});

test("assertDesktopLogHasNoCatalogMismatch accepts a clean desktop snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-log-clean-"));
  const logPath = join(root, "desktop.log");
  await writeFile(logPath, 'time=... msg="desktop app ready"\n');
  assert.deepEqual(await assertDesktopLogHasNoCatalogMismatch(logPath), {
    checked: true
  });
});

test("read helpers tolerate missing artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-missing-"));
  assert.equal(await readCatalogRevisionFromFile(join(root, "nope.ts")), null);
  assert.equal(await readCatalogRevisionFromBinary(join(root, "nope")), null);
  assert.equal(await readCatalogRevisionFromDesktopRendererOut(root), null);
  const result = await assertEventStreamCatalogAligned({
    daemonPath: join(root, "missing-daemon"),
    workspaceRoot: root
  });
  assert.equal(result.checked, false);
});

test("formatCatalogMismatchError mentions rebuild guidance", () => {
  const message = formatCatalogMismatchError({
    daemonRevision: "sha256:aaaa",
    daemonSource: "daemon-binary",
    desktopRevision: "sha256:bbbb",
    desktopSource: "desktop-out-renderer"
  });
  assert.match(message, /desktop-out-renderer=sha256:bbbb/);
  assert.match(message, /daemon-binary=sha256:aaaa/);
  assert.match(message, /Rebuild desktop/);
});
