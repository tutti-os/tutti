#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(scriptDirectory, "../..");
const supportedExtensions = new Set([".png"]);

const directoryBudgets = [
  {
    prefix: "apps/desktop/src/renderer/src/assets/workspace-canvas/dock/",
    maxLongEdge: 192,
    maxBytes: 96 * 1024
  },
  {
    prefix: "packages/agent/gui/app/renderer/assets/icons/agents/",
    maxLongEdge: 192,
    maxBytes: 96 * 1024
  },
  {
    prefix: "packages/agent/gui/app/renderer/assets/icons/agent-vinyls/",
    maxLongEdge: 128,
    maxBytes: 96 * 1024
  },
  {
    prefix: "apps/desktop/src/renderer/src/features/app-update/assets/",
    maxLongEdge: 64,
    maxBytes: 32 * 1024
  }
];

const exactBudgets = new Map(
  [
    [
      "apps/desktop/src/renderer/src/assets/account-plans/reward-toast-bg.png",
      560,
      512 * 1024
    ],
    [
      "packages/agent/gui/app/renderer/assets/icons/agent-vinyl-player-chassis.png",
      192,
      96 * 1024
    ],
    [
      "packages/agent/gui/app/renderer/assets/icons/agent-vinyl-tonearm.png",
      192,
      96 * 1024
    ],
    [
      "packages/agent/gui/app/renderer/assets/icons/user-avatar-placeholder.png",
      128,
      64 * 1024
    ],
    [
      "packages/browser/workbench-node/src/assets/workspace-dock-website.png",
      192,
      96 * 1024
    ],
    [
      "packages/workspace/issue-manager/src/assets/workspace-dock-task.png",
      192,
      96 * 1024
    ],
    [
      "packages/workspace/file-manager/src/assets/workspace-archive-fallback.png",
      256,
      128 * 1024
    ],
    [
      "packages/commerce/web/src/assets/registration-credits-bg.png",
      560,
      512 * 1024
    ],
    ["packages/commerce/web/src/assets/star-free.png", 64, 32 * 1024],
    ["packages/commerce/web/src/assets/star-lite.png", 64, 32 * 1024],
    ["packages/commerce/web/src/assets/star-pro.png", 64, 32 * 1024],
    ["packages/commerce/web/src/assets/star-ultra.png", 64, 32 * 1024],
    [
      "services/tuttid/builtin-apps/tutti-onboarding/public/assets/icon-at.png",
      64,
      32 * 1024
    ],
    [
      "services/tuttid/builtin-apps/tutti-onboarding/public/assets/icon-clipboard.png",
      64,
      32 * 1024
    ],
    [
      "services/tuttid/builtin-apps/tutti-onboarding/public/assets/icon-electric-plug.png",
      64,
      32 * 1024
    ],
    [
      "services/tuttid/builtin-apps/tutti-onboarding/public/assets/icon-joystick.png",
      64,
      32 * 1024
    ],
    [
      "services/tuttid/builtin-apps/tutti-onboarding/public/assets/icon-satellite-antenna.png",
      64,
      32 * 1024
    ],
    [
      "services/tuttid/builtin-apps/tutti-onboarding/public/assets/icon-toolbox.png",
      64,
      32 * 1024
    ],
    [
      "services/tuttid/builtin-apps/tutti-onboarding/public/assets/icon-window-layout.png",
      64,
      32 * 1024
    ],
    [
      "services/tuttid/builtin-apps/tutti-onboarding/public/assets/logo1.png",
      128,
      64 * 1024
    ],
    [
      "services/tuttid/builtin-apps/tutti-onboarding/public/assets/tone-light.png",
      128,
      64 * 1024
    ]
  ].map(([path, maxLongEdge, maxBytes]) => [path, { maxLongEdge, maxBytes }])
);

export function runtimeImageBudgetForPath(path) {
  const normalized = normalizePath(path);
  const exact = exactBudgets.get(normalized);
  if (exact) {
    return exact;
  }

  return directoryBudgets.find(({ prefix }) => normalized.startsWith(prefix));
}

export function isRuntimeImageBudgetPath(path) {
  return (
    supportedExtensions.has(extname(path).toLowerCase()) &&
    runtimeImageBudgetForPath(path) !== undefined
  );
}

export function readPngDimensions(content) {
  if (
    content.length < 24 ||
    !content
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    content.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("not a valid PNG header");
  }

  const width = content.readUInt32BE(16);
  const height = content.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new Error("PNG dimensions must be positive");
  }
  return { width, height };
}

export function analyzeRuntimeImage({ path, content }) {
  const budget = runtimeImageBudgetForPath(path);
  if (!budget) {
    return [];
  }

  let dimensions;
  try {
    dimensions = readPngDimensions(content);
  } catch (error) {
    return [`${path}: ${error.message}`];
  }

  const diagnostics = [];
  const longEdge = Math.max(dimensions.width, dimensions.height);
  if (longEdge > budget.maxLongEdge) {
    diagnostics.push(
      `${path}: ${dimensions.width}×${dimensions.height} exceeds ${budget.maxLongEdge}px long-edge budget`
    );
  }
  if (content.length > budget.maxBytes) {
    diagnostics.push(
      `${path}: ${formatBytes(content.length)} exceeds ${formatBytes(budget.maxBytes)} file budget`
    );
  }
  return diagnostics;
}

export function checkRuntimeImageBudgets({
  workspaceRoot = defaultWorkspaceRoot,
  staged = false
} = {}) {
  const paths = listPaths({ workspaceRoot, staged });
  const diagnostics = paths.flatMap((path) =>
    analyzeRuntimeImage({
      path,
      content: readContent({ workspaceRoot, path, staged })
    })
  );

  return { diagnostics, paths };
}

function listPaths({ workspaceRoot, staged }) {
  const args = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
    : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  return execFileSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8"
  })
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .filter(isRuntimeImageBudgetPath)
    .filter((path) => staged || existsSync(join(workspaceRoot, path)));
}

function readContent({ workspaceRoot, path, staged }) {
  if (staged) {
    return execFileSync("git", ["show", `:${path}`], {
      cwd: workspaceRoot,
      maxBuffer: 20 * 1024 * 1024
    });
  }
  return readFileSync(join(workspaceRoot, path));
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function formatBytes(bytes) {
  return `${Math.ceil(bytes / 1024)} KiB`;
}

function runCli() {
  const staged = process.argv.includes("--staged");
  const { diagnostics, paths } = checkRuntimeImageBudgets({ staged });

  if (diagnostics.length > 0) {
    console.error(
      "Runtime image budget check failed. Keep design masters under design-assets/runtime-images/originals and commit a bounded runtime copy:"
    );
    for (const diagnostic of diagnostics) {
      console.error(`- ${diagnostic}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Runtime image budgets passed (${paths.length} ${staged ? "staged " : ""}assets)`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli();
}
